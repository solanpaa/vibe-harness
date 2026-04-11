import { Hono } from "hono";

const health = new Hono();

health.get("/health", (c) =>
  c.json({ status: "ok", service: "vibe-harness-daemon" }),
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
