import { Hono } from "hono";

const health = new Hono();
const startedAt = Date.now();

health.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "vibe-harness-daemon",
    version: "0.1.0",
    pid: process.pid,
    ready: true,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
  }),
);

// /api/prerequisites is intentionally auth-protected (not on /health).
// The GUI calls it after connecting with a valid token to check host deps.
health.get("/api/prerequisites", (c) =>
  c.json({
    docker: { installed: false, checked: false },
    git: { installed: false, checked: false },
  }),
);

export { health };
