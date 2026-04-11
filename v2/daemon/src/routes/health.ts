import { Hono } from "hono";

const health = new Hono();

health.get("/health", (c) =>
  c.json({ status: "ok", service: "vibe-harness-daemon" }),
);

health.get("/api/prerequisites", (c) =>
  c.json({
    docker: { installed: false, checked: false },
    git: { installed: false, checked: false },
  }),
);

export { health };
