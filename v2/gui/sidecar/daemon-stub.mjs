#!/usr/bin/env node

// Minimal Node.js HTTP daemon stub for Vibe Harness.
// Picks a random port, writes connection info to ~/.vibe-harness/,
// and responds to GET /health.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STATE_DIR = path.join(os.homedir(), ".vibe-harness");
const PORT_FILE = path.join(STATE_DIR, "daemon.port");
const PID_FILE = path.join(STATE_DIR, "daemon.pid");

const startTime = Date.now();

function cleanup() {
  try { fs.unlinkSync(PORT_FILE); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

fs.mkdirSync(STATE_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({
      status: "ok",
      pid: process.pid,
      uptime: Math.round((Date.now() - startTime) / 1000),
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// Listen on port 0 to let the OS pick a random available port
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = addr.port;

  fs.writeFileSync(PORT_FILE, String(port));
  fs.writeFileSync(PID_FILE, String(process.pid));

  console.log(`daemon-stub listening on 127.0.0.1:${port} (pid ${process.pid})`);
});
