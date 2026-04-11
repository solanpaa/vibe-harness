import { randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { createMiddleware } from "hono/factory";
import { getConfigDir } from "./config.js";

const TOKEN_FILE = "auth.token";
const TOKEN_BYTES = 32; // 256-bit

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function getOrCreateToken(): string {
  const tokenPath = join(getConfigDir(), TOKEN_FILE);
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, "utf-8").trim();
  }
  const token = generateToken();
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

export function authMiddleware() {
  const token = getOrCreateToken();

  return createMiddleware(async (c, next) => {
    // Skip auth for health endpoint
    if (c.req.path === "/health") {
      return next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const provided = authHeader.slice("Bearer ".length);
    if (provided !== token) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return next();
  });
}
