#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ACP Testbench — Using the official @agentclientprotocol/sdk
//
// Tests: copilot --acp --stdio (directly, no docker sandbox)
// Then:  docker sandbox run copilot <dir> -- --yolo --acp --stdio
//
// Usage:
//   node scripts/acp-testbench.mjs [project-dir]
//   node scripts/acp-testbench.mjs --docker .     # use docker sandbox
//
// Protocol reference: https://docs.github.com/en/copilot/reference/acp-server
// ---------------------------------------------------------------------------

import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { Readable, Writable } from "node:stream";

const useDocker = process.argv.includes("--docker");
const PROJECT_DIR = process.argv.filter(a => a !== "--docker").at(2) || process.cwd();
const TIMEOUT_MS = 120_000;
const INTERVENTION_DELAY_MS = 15_000;

const PROMPT = "List the top-level files in this directory and describe what this project does in 2-3 sentences. Be brief.";
const INTERVENTION = "Now also tell me what language and framework this project uses.";

function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}]`, ...args);
}

async function main() {
  log("INFO", `Mode: ${useDocker ? "docker sandbox" : "direct copilot"}`);
  log("INFO", `Project dir: ${PROJECT_DIR}`);
  log("INFO", `Prompt: "${PROMPT}"`);
  log("INFO", `Intervention (after ${INTERVENTION_DELAY_MS / 1000}s): "${INTERVENTION}"`);
  log("INFO", "");

  // Build the command
  let cmd, args;

  // Get GitHub token for sandbox auth
  if (!process.env.GITHUB_TOKEN) {
    try {
      const { execSync: es } = await import("node:child_process");
      process.env.GITHUB_TOKEN = es("gh auth token", { encoding: "utf-8" }).trim();
    } catch { /* ok */ }
  }

  if (useDocker) {
    cmd = "docker";
    // Use create + exec -i pattern for clean ACP stdio
    const sandboxName = "acp-testbench";
    // Create sandbox first (synchronous)
    log("SETUP", "Creating sandbox...");
    try {
      const { execSync: es } = await import("node:child_process");
      es(`docker sandbox create --name ${sandboxName} copilot ${PROJECT_DIR}`, { stdio: "inherit" });
    } catch {
      log("SETUP", "Sandbox may already exist, continuing...");
    }
    args = ["sandbox", "exec", "-i", "-e", `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ""}`, sandboxName, "copilot", "--acp", "--stdio", "--yolo"];
  } else {
    cmd = process.env.COPILOT_CLI_PATH ?? "copilot";
    args = ["--acp", "--stdio"];
  }

  log("SPAWN", `${cmd} ${args.join(" ")}`);

  const proc = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "inherit"], // inherit stderr so we see it
    cwd: PROJECT_DIR,
  });

  if (!proc.stdin || !proc.stdout) {
    log("FATAL", "Failed to start process with piped stdio");
    process.exit(1);
  }

  // Overall timeout
  const timer = setTimeout(() => {
    log("TIMEOUT", `${TIMEOUT_MS / 1000}s timeout reached, killing`);
    proc.kill("SIGTERM");
  }, TIMEOUT_MS);

  // With docker sandbox exec -i, stdout is clean NDJSON — connect SDK directly
  const output = Writable.toWeb(proc.stdin);
  const input = Readable.toWeb(proc.stdout);
  const stream = acp.ndJsonStream(output, input);

  let messageCount = 0;
  let interventionSent = false;
  let sessionId = null;

  // Implement ACP client callbacks
  const client = {
    async requestPermission(params) {
      log("PERM", `Agent requests permission: ${JSON.stringify(params).slice(0, 200)}`);
      // Auto-approve everything (like --yolo)
      return { outcome: { outcome: "approved" } };
    },

    async sessionUpdate(params) {
      const update = params.update;
      const type = update?.sessionUpdate;

      if (type === "agent_message_chunk") {
        const content = update.content;
        if (content?.type === "text") {
          process.stdout.write(content.text);
          messageCount++;
        } else if (content?.type === "tool_use") {
          log("TOOL", `▶ ${content.name || "?"} ${JSON.stringify(content.input || {}).slice(0, 100)}`);
        } else if (content?.type === "thinking") {
          log("THINK", (content.text || "").slice(0, 80));
        } else {
          log("UPDATE", `[${content?.type || "?"}]`, JSON.stringify(content).slice(0, 150));
        }
      } else if (type === "tool_result") {
        log("TOOL", `✓ result (${JSON.stringify(update).slice(0, 80)})`);
      } else if (type === "agent_turn_start") {
        log("TURN", "Agent turn started");
      } else if (type === "agent_turn_end") {
        log("TURN", "Agent turn ended");
        process.stdout.write("\n");
      } else {
        log("UPDATE", `[${type || "?"}]`, JSON.stringify(params).slice(0, 200));
      }
    },
  };

  // Establish connection
  log("STEP", "1/4 — Initializing ACP connection");
  const connection = new acp.ClientSideConnection((_agent) => client, stream);

  try {
    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    log("OK", `Initialized. Protocol version: ${acp.PROTOCOL_VERSION}`);
    log("INFO", `Server capabilities: ${JSON.stringify(initResult).slice(0, 300)}`);
  } catch (err) {
    log("FATAL", `Initialize failed: ${err.message}`);
    proc.kill("SIGTERM");
    process.exit(1);
  }

  // Create session
  log("STEP", "2/4 — Creating session");
  try {
    const absCwd = (await import("node:path")).resolve(PROJECT_DIR);
    log("INFO", `Using cwd: ${absCwd}`);
    const sessionResult = await connection.newSession({
      cwd: absCwd,
      mcpServers: [],
    });
    sessionId = sessionResult.sessionId;
    log("OK", `Session created: ${sessionId}`);
  } catch (err) {
    log("FATAL", `session/new failed: ${err.message}`);
    proc.kill("SIGTERM");
    process.exit(1);
  }

  // Schedule intervention
  const interventionTimer = setTimeout(async () => {
    if (proc.exitCode !== null) return;
    log("STEP", "4/4 — Sending INTERVENTION");
    interventionSent = true;
    try {
      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: INTERVENTION }],
      });
      log("OK", `Intervention complete. stopReason=${result.stopReason}`);
    } catch (err) {
      log("ERROR", `Intervention failed: ${err.message}`);
    }
  }, INTERVENTION_DELAY_MS);

  // Send initial prompt
  log("STEP", "3/4 — Sending prompt");
  log("INFO", "");
  try {
    const promptResult = await connection.prompt({
      sessionId,
      prompt: [{ type: "text", text: PROMPT }],
    });
    log("OK", `Prompt complete. stopReason=${promptResult.stopReason}`);
  } catch (err) {
    log("ERROR", `Prompt failed: ${err.message}`);
  }

  // Wait for intervention if still pending
  if (!interventionSent) {
    log("INFO", "Initial prompt done. Waiting for intervention timer...");
  }

  // Give intervention time to complete, then clean up
  setTimeout(() => {
    clearTimeout(timer);
    clearTimeout(interventionTimer);
    log("INFO", "");
    log("INFO", "═══════════════════════════════════════════");
    log("INFO", `  Message chunks received: ${messageCount}`);
    log("INFO", `  Session ID: ${sessionId}`);
    log("INFO", `  Intervention sent: ${interventionSent ? "✅ YES" : "❌ NO (prompt finished before timer)"}`);
    log("INFO", "═══════════════════════════════════════════");

    proc.stdin.end();
    proc.kill("SIGTERM");
    setTimeout(() => process.exit(0), 2000);
  }, interventionSent ? 1000 : INTERVENTION_DELAY_MS + 30_000);
}

main().catch((err) => {
  log("FATAL", err.message);
  process.exit(1);
});

