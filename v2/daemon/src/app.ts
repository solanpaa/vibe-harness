import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware } from "./lib/auth.js";
import { health } from "./routes/health.js";
import { projects } from "./routes/projects.js";
import { agents } from "./routes/agents.js";
import { workflows } from "./routes/workflows.js";
import { credentials } from "./routes/credentials.js";
import { runs } from "./routes/runs.js";
import { reviews } from "./routes/reviews.js";
import { proposals } from "./routes/proposals.js";
import { settingsRoute } from "./routes/settings.js";
import { ghAccounts } from "./routes/gh-accounts.js";

const app = new Hono();

// CORS — allow Tauri webview and dev server origins
app.use("*", cors({
  origin: ["tauri://localhost", "https://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

// Auth middleware — skips /health automatically
app.use("*", authMiddleware());

// Routes
app.route("/", health);
app.route("/", projects);
app.route("/", agents);
app.route("/", workflows);
app.route("/", credentials);
app.route("/", runs);
app.route("/", reviews);
app.route("/", proposals);
app.route("/", settingsRoute);
app.route("/", ghAccounts);

export default app;
