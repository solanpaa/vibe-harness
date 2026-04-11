import { Hono } from "hono";
import { authMiddleware } from "./lib/auth.js";
import { health } from "./routes/health.js";
import { projects } from "./routes/projects.js";
import { agents } from "./routes/agents.js";
import { workflows } from "./routes/workflows.js";

const app = new Hono();

// Auth middleware — skips /health automatically
app.use("*", authMiddleware());

// Routes
app.route("/", health);
app.route("/", projects);
app.route("/", agents);
app.route("/", workflows);

export default app;
