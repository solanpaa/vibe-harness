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

/// Default daemon port — fixed, no port file needed.
const DEFAULT_DAEMON_PORT: u16 = 19423;

/// Try to connect to an already-running daemon on the fixed port.
/// Validates the response contains our service identifier.
fn try_existing_daemon() -> Option<u16> {
    if quick_health_check(DEFAULT_DAEMON_PORT) {
        Some(DEFAULT_DAEMON_PORT)
    } else {
        None
    }
}

/// Health check: validates service identity, not just any HTTP 200.
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
                // Validate it's our daemon, not some random service
                response.contains("\"service\":\"vibe-harness-daemon\"")
                    && response.contains("\"ready\":true")
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

    let mut cmd = Command::new("node");
    cmd.arg(&script);
    configure_detach(&mut cmd);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn daemon: {e}"))?;
    println!("Daemon spawned with pid {}", child.id());
    Ok(())
}

/// Poll the fixed port until the daemon health check passes.
fn wait_for_daemon(timeout: Duration) -> Result<u16, String> {
    let start = Instant::now();
    let port = DEFAULT_DAEMON_PORT;
    loop {
        if start.elapsed() > timeout {
            return Err(format!("Timed out waiting for daemon on port {port}"));
        }
        if quick_health_check(port) {
            println!("Health check passed on port {port}");
            return Ok(port);
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

            match wait_for_daemon(Duration::from_secs(30)) {
                Ok(new_port) => {
                    if let Some(state) = handle.try_state::<DaemonState>() {
                        state.current_port.store(new_port, Ordering::SeqCst);
                        state.is_connected.store(true, Ordering::SeqCst);
                    }
                    let _ = handle.emit(
                        "daemon-connected",
                        DaemonConnected { port: new_port },
                    );
                }
                Err(e) => eprintln!("Restart failed: {e}"),
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
        .plugin(tauri_plugin_dialog::init())
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

                // Step 3: Wait for daemon to become healthy on fixed port
                match wait_for_daemon(Duration::from_secs(30)) {
                    Ok(port) => {
                        println!("Daemon ready on port {port}");
                        if let Some(state) = handle.try_state::<DaemonState>() {
                            state.current_port.store(port, Ordering::SeqCst);
                            state.is_connected.store(true, Ordering::SeqCst);
                        }
                        let _ = handle.emit("daemon-connected", DaemonConnected { port });
                        start_monitor_loop(handle);
                    }
                    Err(e) => {
                        eprintln!("Daemon startup failed: {e}");
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
