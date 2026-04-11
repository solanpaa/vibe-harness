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
    let url = format!("http://127.0.0.1:{port}/health");
    let start = Instant::now();
    let timeout = Duration::from_secs(10);
    loop {
        if start.elapsed() > timeout {
            return Err("Health check timed out".into());
        }
        // Simple TCP-level check using a blocking HTTP GET
        match std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_secs(2),
        ) {
            Ok(mut stream) => {
                use std::io::{Read, Write};
                let req = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
                if stream.write_all(req.as_bytes()).is_ok() {
                    let mut buf = Vec::new();
                    let _ = stream.read_to_end(&mut buf);
                    let response = String::from_utf8_lossy(&buf);
                    if response.contains("\"status\":\"ok\"") {
                        println!("Health check passed: {url}");
                        return Ok(());
                    }
                }
            }
            Err(_) => {}
        }
        thread::sleep(Duration::from_millis(300));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // Spawn daemon startup in a background thread so we don't block the UI
            thread::spawn(move || {
                match spawn_daemon(&handle) {
                    Ok(child) => {
                        println!("Daemon spawned with pid {}", child.id());
                        // Store the child process so we can kill it on exit
                        handle.manage(DaemonProcess(std::sync::Mutex::new(Some(child))));
                    }
                    Err(e) => {
                        eprintln!("Failed to spawn daemon: {e}");
                        let _ = handle.emit("daemon-error", DaemonError { message: e });
                        return;
                    }
                }

                match poll_for_port(Duration::from_secs(30)) {
                    Ok(port) => {
                        println!("Daemon port: {port}");
                        match health_check(port) {
                            Ok(()) => {
                                let _ = handle.emit("daemon-connected", DaemonConnected { port });
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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Kill the daemon when the window closes
                if let Some(state) = window.try_state::<DaemonProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(ref mut child) = *guard {
                            println!("Killing daemon process {}", child.id());
                            let _ = child.kill();
                            let _ = child.wait(); // reap zombie
                        }
                    }
                }
                // Clean up port/pid files
                let _ = fs::remove_file(state_dir().join("daemon.port"));
                let _ = fs::remove_file(state_dir().join("daemon.pid"));
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

struct DaemonProcess(std::sync::Mutex<Option<Child>>);
