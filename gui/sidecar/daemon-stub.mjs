#!/usr/bin/env node

// Daemon launcher for Vibe Harness GUI.
// Starts the real Nitro daemon (npm run dev in daemon workspace),
// writes PID/port to ~/.vibe-harness/, and keeps running so the
// Rust side can track the process.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STATE_DIR = path.join(os.homedir(), ".vibe-harness");
const PORT_FILE = path.join(STATE_DIR, "daemon.port");
const PID_FILE = path.join(STATE_DIR, "daemon.pid");
const DEFAULT_PORT = 19423;

function cleanup() {
  // Don't remove port/pid files — the child daemon manages those
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

fs.mkdirSync(STATE_DIR, { recursive: true });

// Find the daemon workspace directory (relative to this script)
const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const daemonDir = path.resolve(scriptDir, "..", "..", "daemon");

// Check if we're in the dev source tree
const nitroConfig = path.join(daemonDir, "nitro.config.ts");
if (!fs.existsSync(nitroConfig)) {
  // Fallback: just serve a health endpoint if daemon source not found
  console.error(`daemon-stub: daemon source not found at ${daemonDir}, serving health-only stub`);

  const http = await import("node:http");
  const startTime = Date.now();
  const server = http.createServer((req, res) => {
    // CORS headers on all responses
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pid: process.pid, uptime: Math.round((Date.now() - startTime) / 1000), stub: true }));
      return;
    }

    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Daemon not available. Please start the daemon manually." }));
  });

  server.listen(DEFAULT_PORT, "127.0.0.1", () => {
    const port = server.address().port;
    fs.writeFileSync(PORT_FILE, String(port));
    fs.writeFileSync(PID_FILE, String(process.pid));
    console.log(`daemon-stub (health-only) listening on 127.0.0.1:${port} (pid ${process.pid})`);
  });
} else {
  // Start the real Nitro daemon — it manages its own PID file
  console.log(`daemon-stub: starting Nitro daemon from ${daemonDir}`);

  const child = spawn("npx", ["nitro", "dev", "--port", String(DEFAULT_PORT)], {
    cwd: daemonDir,
    stdio: "inherit",
    env: { ...process.env, NITRO_PORT: String(DEFAULT_PORT) },
  });

  child.on("exit", (code) => {
    console.log(`daemon-stub: Nitro exited with code ${code}`);
    process.exit(code ?? 1);
  });

  console.log(`daemon-stub: launched Nitro on port ${DEFAULT_PORT} (pid ${process.pid})`);
}
