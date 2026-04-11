use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
struct DaemonConnected {
    port: u16,
}

#[derive(Clone, Serialize)]
struct DaemonError {
    message: String,
}

fn state_dir() -> PathBuf {
    dirs::home_dir()
        .expect("could not resolve home directory")
        .join(".vibe-harness")
}

/// Check if a process with the given PID is still alive.
fn is_process_alive(pid: u32) -> bool {
    // On Unix, signal 0 checks if process exists without sending a signal
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        // Fallback: try connecting to health endpoint instead
        false
    }
}

/// Try to connect to an already-running daemon.
/// Returns the port if a daemon is alive and healthy.
fn try_existing_daemon() -> Option<u16> {
    let pid_file = state_dir().join("daemon.pid");
    let port_file = state_dir().join("daemon.port");

    // Read PID file and check if process is alive
    let pid_str = fs::read_to_string(&pid_file).ok()?;
    let pid: u32 = pid_str.trim().parse().ok()?;

    if !is_process_alive(pid) {
        // Stale PID file — clean up
        let _ = fs::remove_file(&pid_file);
        let _ = fs::remove_file(&port_file);
        return None;
    }

    // Process alive — read port
    let port_str = fs::read_to_string(&port_file).ok()?;
    let port: u16 = port_str.trim().parse().ok()?;

    // Quick health check to confirm it's actually our daemon
    if quick_health_check(port) {
        Some(port)
    } else {
        None
    }
}

/// Fast non-blocking health check (2s timeout).
fn quick_health_check(port: u16) -> bool {
    match std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_secs(2),
    ) {
        Ok(mut stream) => {
            use std::io::{Read, Write};
            let req = format!(
                "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            );
            if stream.write_all(req.as_bytes()).is_ok() {
                let mut buf = Vec::new();
                let _ = stream.read_to_end(&mut buf);
                let response = String::from_utf8_lossy(&buf);
                response.contains("\"status\":\"ok\"")
            } else {
                false
            }
        }
        Err(_) => false,
    }
}

fn spawn_daemon(app: &AppHandle) -> Result<Child, String> {
    let sidecar_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?
        .join("sidecar")
        .join("daemon-stub.mjs");

    // Fall back to the source-tree path during `cargo tauri dev`
    let script = if sidecar_path.exists() {
        sidecar_path
    } else {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("sidecar")
            .join("daemon-stub.mjs");
        if dev_path.exists() {
            dev_path
        } else {
            return Err(format!(
                "daemon-stub.mjs not found at {:?} or {:?}",
                sidecar_path, dev_path
            ));
        }
    };

    // Remove stale port/pid files before spawning
    let _ = fs::remove_file(state_dir().join("daemon.port"));
    let _ = fs::remove_file(state_dir().join("daemon.pid"));

    Command::new("node")
        .arg(&script)
        .spawn()
        .map_err(|e| format!("Failed to spawn daemon: {e}"))
}

fn poll_for_port(timeout: Duration) -> Result<u16, String> {
    let port_file = state_dir().join("daemon.port");
    let start = Instant::now();
    loop {
        if start.elapsed() > timeout {
            return Err("Timed out waiting for daemon port file".into());
        }
        if let Ok(contents) = fs::read_to_string(&port_file) {
            if let Ok(port) = contents.trim().parse::<u16>() {
                return Ok(port);
            }
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn health_check(port: u16) -> Result<(), String> {
    let start = Instant::now();
    let timeout = Duration::from_secs(10);
    loop {
        if start.elapsed() > timeout {
            return Err("Health check timed out".into());
        }
        if quick_health_check(port) {
            println!("Health check passed on port {port}");
            return Ok(());
        }
        thread::sleep(Duration::from_millis(300));
    }
}

/// Tracks whether this GUI instance spawned the daemon.
struct DaemonOwnership {
    /// If Some, we spawned it and own the child process.
    child: std::sync::Mutex<Option<Child>>,
    /// True if we spawned the daemon (vs reusing existing).
    we_spawned: std::sync::atomic::AtomicBool,
}

/// Tauri command: read a file from ~/.vibe-harness/{filename}
#[tauri::command]
fn read_state_file(filename: String) -> Result<String, String> {
    // Prevent path traversal
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("Invalid filename".into());
    }
    let path = state_dir().join(&filename);
    fs::read_to_string(&path).map_err(|e| format!("Failed to read {filename}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![read_state_file])
        .setup(|app| {
            let handle = app.handle().clone();

            // Register ownership state early
            handle.manage(DaemonOwnership {
                child: std::sync::Mutex::new(None),
                we_spawned: std::sync::atomic::AtomicBool::new(false),
            });

            // Spawn daemon startup in a background thread so we don't block the UI
            thread::spawn(move || {
                // Step 1: Check if daemon is already running
                if let Some(port) = try_existing_daemon() {
                    println!("Reusing existing daemon on port {port}");
                    let _ = handle.emit("daemon-connected", DaemonConnected { port });
                    return;
                }

                // Step 2: No existing daemon — spawn one
                println!("No existing daemon found, spawning...");
                match spawn_daemon(&handle) {
                    Ok(child) => {
                        println!("Daemon spawned with pid {}", child.id());
                        if let Some(state) = handle.try_state::<DaemonOwnership>() {
                            *state.child.lock().unwrap() = Some(child);
                            state
                                .we_spawned
                                .store(true, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to spawn daemon: {e}");
                        let _ = handle.emit("daemon-error", DaemonError { message: e });
                        return;
                    }
                }

                // Step 3: Wait for port file and health check
                match poll_for_port(Duration::from_secs(30)) {
                    Ok(port) => {
                        println!("Daemon port: {port}");
                        match health_check(port) {
                            Ok(()) => {
                                let _ =
                                    handle.emit("daemon-connected", DaemonConnected { port });
                            }
                            Err(e) => {
                                eprintln!("Health check failed: {e}");
                                let _ = handle.emit("daemon-error", DaemonError { message: e });
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("Port polling failed: {e}");
                        let _ = handle.emit("daemon-error", DaemonError { message: e });
                    }
                }
            });
            Ok(())
        })
        // Per SAD §2.2.3: daemon survives GUI close.
        // We do NOT kill daemon on window close — it's a shared service.
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
