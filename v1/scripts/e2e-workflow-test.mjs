#!/usr/bin/env node
// ---------------------------------------------------------------------------
// E2E Workflow Test
//
// Launches a 3-stage workflow and monitors it through completion.
// Tests: sandbox creation → ACP init → session/new → prompt → auto-complete
//        → review creation → workflow advance → session/load → next stage
//
// Usage:
//   node scripts/e2e-workflow-test.mjs [project-dir]
// ---------------------------------------------------------------------------

const BASE = "http://localhost:3000";
const POLL_INTERVAL = 3000;
const MAX_WAIT_MS = 300_000; // 5 minutes

function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}]`, ...args);
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${res.status} ${url}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const projectDir = process.argv[2] || process.cwd();
  log("INFO", `Project: ${projectDir}`);
  log("INFO", `Base URL: ${BASE}`);
  log("INFO", "");

  // Step 1: Launch workflow
  log("STEP", "1. Starting 3-stage workflow...");
  const result = await fetchJson(`${BASE}/api/test-workflow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectPath: projectDir,
      taskDescription: "List the files in the project root and describe what this project does in 1-2 sentences. Be extremely brief.",
    }),
  });
  log("OK", `Workflow run: ${result.runId}`);
  log("OK", `First task: ${result.taskId} (stage: ${result.stageName})`);
  log("INFO", "");

  // Step 2: Poll until workflow completes or fails
  const startTime = Date.now();
  let lastStatus = "";
  let lastStage = "";
  let completedStages = new Set();

  while (Date.now() - startTime < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));

    const runs = await fetchJson(`${BASE}/api/test-workflow`);
    const run = runs.find((r) => r.id === result.runId);
    if (!run) {
      log("ERROR", "Workflow run not found!");
      process.exit(1);
    }

    // Log status changes
    if (run.status !== lastStatus || run.currentStage !== lastStage) {
      log("STATUS", `Workflow: ${run.status} | Stage: ${run.currentStage} | ACP Session: ${run.acpSessionId || "none"}`);
      lastStatus = run.status;
      lastStage = run.currentStage;
    }

    // Log task details
    for (const task of run.tasks) {
      const key = `${task.stageName}:${task.status}`;
      if (!completedStages.has(key)) {
        completedStages.add(key);
        const msg = task.lastAiMessage ? task.lastAiMessage.slice(0, 100) + "..." : "(no message)";
        log("TASK", `${task.stageName} → ${task.status} | ${msg}`);
      }
    }

    // Check terminal states
    if (run.status === "completed" || run.status === "finalizing") {
      log("OK", "");
      log("OK", "═══════════════════════════════════════════");
      log("OK", "  ✅ WORKFLOW COMPLETED SUCCESSFULLY");
      log("OK", `  Stages completed: ${run.tasks.filter(t => t.status !== "pending").length}`);
      log("OK", `  ACP Session ID: ${run.acpSessionId || "none"}`);
      log("OK", `  Duration: ${Math.round((Date.now() - startTime) / 1000)}s`);
      log("OK", "═══════════════════════════════════════════");

      // Print task summaries
      for (const task of run.tasks) {
        log("SUMMARY", `${task.stageName}: ${task.status} | ${task.lastAiMessage?.slice(0, 150) || "(no output)"}`);
      }

      process.exit(0);
    }

    if (run.status === "failed") {
      log("FAIL", "");
      log("FAIL", "═══════════════════════════════════════════");
      log("FAIL", "  ❌ WORKFLOW FAILED");
      log("FAIL", `  Failed at stage: ${run.currentStage}`);
      log("FAIL", `  Duration: ${Math.round((Date.now() - startTime) / 1000)}s`);
      log("FAIL", "═══════════════════════════════════════════");

      for (const task of run.tasks) {
        if (task.status === "failed") {
          log("FAIL", `${task.stageName}: ${task.lastAiMessage?.slice(0, 200) || "(no output)"}`);
        }
      }

      process.exit(1);
    }

    // Show progress indicator
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r  ⏳ Waiting... ${elapsed}s (${run.status}/${run.currentStage})    `);
  }

  log("TIMEOUT", "Workflow did not complete within timeout");
  process.exit(1);
}

main().catch((err) => {
  log("FATAL", err.message);
  process.exit(1);
});
