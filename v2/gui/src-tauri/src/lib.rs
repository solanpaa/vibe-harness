use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[derive(Clone, Serialize)]
struct DaemonConnected {
    port: u16,
}

#[derive(Clone, Serialize)]
struct DaemonError {
    message: String,
}

#[derive(Clone, Serialize)]
struct SingleInstancePayload {
    args: Vec<String>,
    cwd: String,
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

/// Default daemon port — must match daemon's DEFAULT_PORT.
const DEFAULT_DAEMON_PORT: u16 = 19423;

/// Try to connect to an already-running daemon.
/// Returns the port if a daemon is alive and healthy.
fn try_existing_daemon() -> Option<u16> {
    let pid_file = state_dir().join("daemon.pid");
    let port_file = state_dir().join("daemon.port");

    // Read PID file and check if process is alive
    if let Ok(pid_str) = fs::read_to_string(&pid_file) {
        if let Ok(pid) = pid_str.trim().parse::<u32>() {
            if is_process_alive(pid) {
                // Process alive — read port
                if let Ok(port_str) = fs::read_to_string(&port_file) {
                    if let Ok(port) = port_str.trim().parse::<u16>() {
                        if quick_health_check(port) {
                            return Some(port);
                        }
                    }
                }
            } else {
                // Stale PID file — clean up
                let _ = fs::remove_file(&pid_file);
                let _ = fs::remove_file(&port_file);
            }
        }
    }

    // Fallback: try the default port in case daemon is running
    // but port/pid files are stale or missing
    if quick_health_check(DEFAULT_DAEMON_PORT) {
        return Some(DEFAULT_DAEMON_PORT);
    }

    None
}

/// Fast non-blocking health check (2s connect + 3s read timeout).
fn quick_health_check(port: u16) -> bool {
    match std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_secs(2),
    ) {
        Ok(mut stream) => {
            use std::io::{Read, Write};
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
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

/// Detach spawned process from parent process group (Unix only).
#[cfg(unix)]
fn configure_detach(cmd: &mut Command) {
    // SAFETY: setsid() after fork creates a new session so the daemon
    // survives GUI exit without receiving SIGHUP.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn configure_detach(_cmd: &mut Command) {}

fn spawn_daemon(app: &AppHandle) -> Result<(), String> {
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

    let mut cmd = Command::new("node");
    cmd.arg(&script);
    configure_detach(&mut cmd);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn daemon: {e}"))?;
    println!("Daemon spawned with pid {}", child.id());
    Ok(())
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

/// Tracks daemon connection state for the get_daemon_status command.
struct DaemonState {
    current_port: AtomicU16,
    is_connected: AtomicBool,
}

/// Background monitor: polls daemon health every 5s, restarts after 3 consecutive failures.
fn start_monitor_loop(handle: AppHandle) {
    thread::spawn(move || {
        let mut fail_count = 0u32;

        loop {
            thread::sleep(Duration::from_secs(5));

            let port = if let Some(state) = handle.try_state::<DaemonState>() {
                state.current_port.load(Ordering::SeqCst)
            } else {
                continue;
            };
            if port == 0 {
                continue;
            }

            if quick_health_check(port) {
                fail_count = 0;
                continue;
            }

            fail_count += 1;
            eprintln!("Daemon health check failed ({fail_count}/3)");

            if fail_count < 3 {
                continue;
            }

            // 3 consecutive failures — emit error and attempt restart
            let _ = handle.emit(
                "daemon-error",
                DaemonError {
                    message: "Daemon unresponsive, restarting...".into(),
                },
            );
            if let Some(state) = handle.try_state::<DaemonState>() {
                state.is_connected.store(false, Ordering::SeqCst);
            }

            // Reset counter so we wait another 3 failures before retrying
            fail_count = 0;

            if let Err(e) = spawn_daemon(&handle) {
                eprintln!("Restart spawn failed: {e}");
                continue;
            }

            match poll_for_port(Duration::from_secs(30)) {
                Ok(new_port) => {
                    if health_check(new_port).is_ok() {
                        if let Some(state) = handle.try_state::<DaemonState>() {
                            state.current_port.store(new_port, Ordering::SeqCst);
                            state.is_connected.store(true, Ordering::SeqCst);
                        }
                        let _ = handle.emit(
                            "daemon-connected",
                            DaemonConnected { port: new_port },
                        );
                    }
                }
                Err(e) => eprintln!("Restart port poll failed: {e}"),
            }
        }
    });
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

/// Tauri command: return current daemon port if connected, else null.
#[tauri::command]
fn get_daemon_status(
    state: tauri::State<'_, DaemonState>,
) -> Result<Option<DaemonConnected>, String> {
    if state.is_connected.load(Ordering::SeqCst) {
        let port = state.current_port.load(Ordering::SeqCst);
        if port > 0 {
            return Ok(Some(DaemonConnected { port }));
        }
    }
    Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Single-instance: must be registered FIRST
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // When a second instance launches, focus the existing window
            let _ = app.emit("single-instance", SingleInstancePayload { args: argv, cwd });
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_notification::init());

    // MCP Bridge — dev-only, enables AI-driven UI automation & debugging
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }

    let app = builder
        .invoke_handler(tauri::generate_handler![read_state_file, get_daemon_status])
        .setup(|app| {
            let handle = app.handle().clone();

            handle.manage(DaemonState {
                current_port: AtomicU16::new(0),
                is_connected: AtomicBool::new(false),
            });

            // Spawn daemon startup in a background thread so we don't block the UI
            thread::spawn(move || {
                // Step 1: Check if daemon is already running
                if let Some(port) = try_existing_daemon() {
                    println!("Reusing existing daemon on port {port}");
                    if let Some(state) = handle.try_state::<DaemonState>() {
                        state.current_port.store(port, Ordering::SeqCst);
                        state.is_connected.store(true, Ordering::SeqCst);
                    }
                    let _ = handle.emit("daemon-connected", DaemonConnected { port });
                    start_monitor_loop(handle);
                    return;
                }

                // Step 2: No existing daemon — spawn one
                println!("No existing daemon found, spawning...");
                if let Err(e) = spawn_daemon(&handle) {
                    eprintln!("Failed to spawn daemon: {e}");
                    let _ = handle.emit("daemon-error", DaemonError { message: e });
                    return;
                }

                // Step 3: Wait for port file and health check
                match poll_for_port(Duration::from_secs(30)) {
                    Ok(port) => {
                        println!("Daemon port: {port}");
                        match health_check(port) {
                            Ok(()) => {
                                if let Some(state) = handle.try_state::<DaemonState>() {
                                    state.current_port.store(port, Ordering::SeqCst);
                                    state.is_connected.store(true, Ordering::SeqCst);
                                }
                                let _ =
                                    handle.emit("daemon-connected", DaemonConnected { port });
                                start_monitor_loop(handle);
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Per SAD §2.2.3: daemon survives GUI close.
    // We do NOT kill daemon on exit — it's a shared service.
    app.run(|_app_handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            // Intentionally empty — daemon is not terminated.
        }
    });
}
