#!/usr/bin/env node

import { execSync, execFileSync, spawn } from "child_process";
import { existsSync, mkdirSync, cpSync, rmSync, renameSync, writeFileSync, readFileSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// When installed via npx, the package lands inside a wrapper's node_modules/.
// Detect the wrapper root so we can find sibling packages like `next`.
function findWrapperRoot() {
  // PROJECT_ROOT is e.g. ~/.npm/_npx/.../node_modules/vibe-harness
  // Wrapper root is e.g. ~/.npm/_npx/.../
  const nmIndex = PROJECT_ROOT.lastIndexOf(path.sep + "node_modules" + path.sep);
  if (nmIndex !== -1) {
    return PROJECT_ROOT.substring(0, nmIndex);
  }
  return PROJECT_ROOT;
}
const WRAPPER_ROOT = findWrapperRoot();

// Resolve the next binary — could be in PROJECT_ROOT/node_modules or WRAPPER_ROOT/node_modules
function findNextBin() {
  const local = path.join(PROJECT_ROOT, "node_modules", "next", "dist", "bin", "next");
  if (existsSync(local)) return local;
  const wrapper = path.join(WRAPPER_ROOT, "node_modules", "next", "dist", "bin", "next");
  if (existsSync(wrapper)) return wrapper;
  return "next"; // fallback to PATH
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function getFlag(name) {
  return args.includes(`--${name}`);
}

function getOption(name, defaultValue) {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return defaultValue;
}

if (getFlag("help") || getFlag("h")) {
  console.log(`
  vibe-harness — AI coding agent orchestrator

  Usage:
    npx github:solanpaa/vibe-harness [options]

  Options:
    --port <number>    Port to run on (default: 3000)
    --no-open          Don't open browser automatically
    --data-dir <path>  Data directory (default: ~/.vibe-harness)
    --help, -h         Show this help message
  `);
  process.exit(0);
}

const port = getOption("port", "3000");
const noOpen = getFlag("no-open");
const dataDir = getOption("data-dir", path.join(homedir(), ".vibe-harness"));

// ---------------------------------------------------------------------------
// Prerequisite checks
// ---------------------------------------------------------------------------
const checks = [
  {
    name: "Node.js >= 24",
    test: () => {
      const major = parseInt(process.versions.node.split(".")[0], 10);
      if (major < 24) throw new Error(`Found Node.js ${process.versions.node}, need >= 24`);
    },
  },
  {
    name: "git",
    test: () => {
      try {
        execFileSync("git", ["--version"], { stdio: "pipe" });
      } catch {
        throw new Error("Install git: https://git-scm.com/downloads");
      }
    },
  },
  {
    name: "Docker",
    test: () => {
      try {
        execFileSync("docker", ["info"], { stdio: "pipe", timeout: 5000 });
      } catch {
        throw new Error("Docker not running. Install: https://docs.docker.com/get-docker/");
      }
    },
  },
  {
    name: "GitHub CLI (gh)",
    test: () => {
      try {
        execFileSync("gh", ["auth", "status"], { stdio: "pipe", timeout: 5000 });
      } catch {
        throw new Error("Install & authenticate gh: https://cli.github.com/");
      }
    },
  },
  {
    name: "Copilot CLI",
    test: () => {
      try {
        execFileSync("which", ["copilot"], { stdio: "pipe", timeout: 5000 });
      } catch {
        throw new Error("Install Copilot CLI: https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line");
      }
    },
  },
];

console.log("\n🔍 Checking prerequisites...\n");

let allPassed = true;
for (const check of checks) {
  try {
    check.test();
    console.log(`  ✅ ${check.name}`);
  } catch (e) {
    console.log(`  ❌ ${check.name}: ${e.message}`);
    allPassed = false;
  }
}

if (!allPassed) {
  console.log("\n⚠️  Some prerequisites are missing. Vibe Harness may not work correctly.\n");
}

// ---------------------------------------------------------------------------
// Data directory setup
// ---------------------------------------------------------------------------
if (!existsSync(dataDir)) {
  console.log(`\n📁 Creating data directory: ${dataDir}`);
  mkdirSync(dataDir, { recursive: true });
}

const dbPath = `file:${path.join(dataDir, "vibe-harness.db")}`;

// ---------------------------------------------------------------------------
// First-run build
// ---------------------------------------------------------------------------
const nextDir = path.join(PROJECT_ROOT, ".next");
if (!existsSync(nextDir)) {
  console.log("\n🔨 First run detected — building Vibe Harness (this takes ~30s)...\n");
  const nextBin = findNextBin();
  const isInsideNodeModules = PROJECT_ROOT !== WRAPPER_ROOT;

  // --- Build lock: prevent concurrent builds from corrupting .next/ ---
  const lockFile = path.join(dataDir, ".build.lock");
  const LOCK_STALE_MS = 2 * 60 * 1000;  // 2 minutes
  const LOCK_POLL_MS = 2000;             // poll every 2s
  const LOCK_WAIT_MS = 5 * 60 * 1000;   // wait up to 5 minutes

  if (existsSync(lockFile)) {
    let stale = false;
    try {
      const lockAge = Date.now() - statSync(lockFile).mtimeMs;
      const lockContent = readFileSync(lockFile, "utf-8").trim();
      const lockTs = Number(lockContent);
      const age = Number.isFinite(lockTs) ? Date.now() - lockTs : lockAge;
      stale = age > LOCK_STALE_MS;
    } catch {
      stale = true;
    }

    if (stale) {
      try { unlinkSync(lockFile); } catch { /* ignore */ }
    } else {
      console.log("⏳ Another build is in progress, waiting...");
      const waitStart = Date.now();
      while (existsSync(lockFile) && Date.now() - waitStart < LOCK_WAIT_MS) {
        execSync(`sleep 2`, { stdio: "pipe" });
      }
      if (existsSync(lockFile)) {
        console.error("❌ Timed out waiting for another build to finish.");
        process.exit(1);
      }
      // Other build finished — check if .next/ now exists
      if (existsSync(nextDir)) {
        console.log("✅ Build completed by another process.\n");
      }
    }
  }

  // Re-check: the other process may have produced .next/ while we waited
  if (!existsSync(nextDir)) {
    writeFileSync(lockFile, Date.now().toString());
    try {
      if (isInsideNodeModules) {
        // Build in a dedicated cache dir under dataDir so we never write to
        // shared system directories (e.g. /usr/local/lib for global installs).
        const BUILD_DIR = path.join(dataDir, ".build-cache");
        if (!existsSync(BUILD_DIR)) mkdirSync(BUILD_DIR, { recursive: true });

        const filesToCopy = [
          "src", "public", "next.config.ts", "tsconfig.json",
          "postcss.config.mjs", "components.json",
        ];
        const createdItems = [];

        // Copy node_modules from wrapper root so Next.js can resolve deps
        const wrapperNm = path.join(WRAPPER_ROOT, "node_modules");
        const buildNm = path.join(BUILD_DIR, "node_modules");
        if (existsSync(wrapperNm) && !existsSync(buildNm)) {
          cpSync(wrapperNm, buildNm, { recursive: true });
          createdItems.push(buildNm);
        }

        for (const f of filesToCopy) {
          const source = path.join(PROJECT_ROOT, f);
          const dest = path.join(BUILD_DIR, f);
          if (existsSync(dest)) {
            rmSync(dest, { recursive: true, force: true });
          }
          if (existsSync(source)) {
            cpSync(source, dest, { recursive: true });
            createdItems.push(dest);
          }
        }

        try {
          execSync(`node "${nextBin}" build`, {
            cwd: BUILD_DIR,
            stdio: "inherit",
            env: { ...process.env, DATABASE_URL: dbPath },
          });

          // Move .next from build dir to package dir
          const builtNext = path.join(BUILD_DIR, ".next");
          if (existsSync(builtNext)) {
            renameSync(builtNext, nextDir);
          }
        } finally {
          // Clean up copied files
          for (const item of createdItems) {
            try { rmSync(item, { recursive: true, force: true }); } catch { /* ignore */ }
          }
        }
      } else {
        // Normal dev/local install — build directly
        execSync(`node "${nextBin}" build`, {
          cwd: PROJECT_ROOT,
          stdio: "inherit",
          env: { ...process.env, DATABASE_URL: dbPath },
        });
      }

      console.log("\n✅ Build complete!\n");
    } catch (e) {
      try { unlinkSync(lockFile); } catch { /* ignore */ }
      console.error("\n❌ Build failed. Check errors above.");
      process.exit(1);
    } finally {
      try { unlinkSync(lockFile); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Docker sandbox image check
// ---------------------------------------------------------------------------
try {
  const images = execFileSync("docker", ["images", "-q", "vibe-harness/copilot:latest"], {
    stdio: "pipe",
    timeout: 5000,
  }).toString().trim();

  if (!images) {
    console.log("\n🐳 Docker sandbox image not found. Building it now...\n");
    const buildScript = path.join(PROJECT_ROOT, "docker", "build.sh");
    if (existsSync(buildScript)) {
      execSync(`bash "${buildScript}"`, { cwd: PROJECT_ROOT, stdio: "inherit" });
      console.log("\n✅ Docker sandbox image built!\n");
    } else {
      console.log("⚠️  docker/build.sh not found. Build the image manually:");
      console.log("   docker build -t vibe-harness/copilot:latest -f docker/Dockerfile.copilot docker/\n");
    }
  }
} catch {
  console.log("⚠️  Could not check for Docker sandbox image.\n");
}

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------
console.log(`\n🚀 Starting Vibe Harness on http://localhost:${port}\n`);

const server = spawn("node", [findNextBin(), "start", "-p", port], {
  cwd: PROJECT_ROOT,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: dbPath, PORT: port },
});

// Open browser after a short delay
if (!noOpen) {
  setTimeout(() => {
    const url = `http://localhost:${port}`;
    try {
      const platform = process.platform;
      if (platform === "darwin") execSync(`open "${url}"`, { stdio: "pipe" });
      else if (platform === "linux") execSync(`xdg-open "${url}"`, { stdio: "pipe" });
      else if (platform === "win32") execSync(`start "${url}"`, { stdio: "pipe" });
    } catch {
      // Silently fail — user can open browser manually
    }
  }, 2000);
}

// Graceful shutdown
function shutdown() {
  console.log("\n\n👋 Shutting down Vibe Harness...");
  server.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.on("exit", (code) => {
  process.exit(code ?? 0);
});
