import { Hono } from "hono";
import { authMiddleware } from "./lib/auth.js";
import { health } from "./routes/health.js";

const app = new Hono();

// Auth middleware — skips /health automatically
app.use("*", authMiddleware());

// Routes
app.route("/", health);

export default app;
