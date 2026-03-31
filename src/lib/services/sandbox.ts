import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { buildSandboxCredentials } from "./credential-vault";
import { CopilotJsonlParser, ParsedAgentOutput } from "./jsonl-parser";

export interface SandboxOptions {
  projectDir: string;
  agentCommand: string;
  credentialSetId?: string | null;
  dockerImage?: string | null;
  prompt?: string;
  model?: string | null;
  isContinuation?: boolean;
  agentArgs?: string[];
  sandboxName?: string;
}

export interface SandboxInstance {
  id: string;
  process: ChildProcess;
  output: string[];
  events: EventEmitter;
  workDir: string;
  jsonlParser: CopilotJsonlParser;
  parsedOutput?: ParsedAgentOutput;
}

// Persist across Next.js hot reloads in dev mode
const globalForSandboxes = globalThis as unknown as {
  __vibeActiveSandboxes?: Map<string, SandboxInstance>;
};
const activeSandboxes =
  globalForSandboxes.__vibeActiveSandboxes ??
  (globalForSandboxes.__vibeActiveSandboxes = new Map<string, SandboxInstance>());

/**
 * Build the command for launching an agent in a Docker sandbox.
 *
 * Syntax: docker sandbox run [OPTIONS] AGENT [WORKSPACE] [-- AGENT_ARGS...]
 *
 * Agent args for Copilot CLI:
 *   --yolo              Autonomous mode (no approval prompts)
 *   -p "prompt"         Pass prompt directly
 *   --model <model>     Select model (e.g. claude-opus-4.6)
 *   --continue          Continue previous sandbox session
 */
function buildSandboxCommand(options: SandboxOptions, taskId?: string): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const args: string[] = ["sandbox", "run"];
  const env = { ...process.env };

  if (options.isContinuation && options.sandboxName) {
    args.push(options.sandboxName);
  } else {
    if (options.sandboxName) {
      args.push("--name", options.sandboxName);
    }

    if (options.dockerImage) {
      args.push("-t", options.dockerImage);
    }

    args.push(options.agentCommand);
    args.push(options.projectDir);
  }

  const agentArgs: string[] = ["--yolo", "--output-format", "json"];

  if (options.prompt) {
    agentArgs.push("-p", options.prompt);
  }

  if (options.model) {
    agentArgs.push("--model", options.model);
  }

  if (options.isContinuation) {
    agentArgs.push("--continue");
  }

  if (options.agentArgs?.length) {
    agentArgs.push(...options.agentArgs);
  }

  args.push("--", ...agentArgs);

  // Inject credential vault env vars
  if (options.credentialSetId) {
    const creds = buildSandboxCredentials(options.credentialSetId, taskId);
    for (const [key, value] of Object.entries(creds.envVars)) {
      env[key] = value;
    }
  }

  return { command: "docker", args, env };
}

export function launchSandbox(
  taskId: string,
  options: SandboxOptions
): SandboxInstance {
  const { command, args, env } = buildSandboxCommand(options, taskId);
  const events = new EventEmitter();
  const output: string[] = [];
  const jsonlParser = new CopilotJsonlParser();

  // Try to get GITHUB_TOKEN from gh CLI if not already set
  if (!env.GITHUB_TOKEN && !env.GH_TOKEN) {
    try {
      const token = require("child_process")
        .execSync("gh auth token", { encoding: "utf-8" })
        .trim();
      if (token) env.GITHUB_TOKEN = token;
    } catch {
      // gh CLI not available or not authenticated
    }
  }

  const proc = spawn(command, args, {
    env,
    cwd: options.projectDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Buffer stdout data and split on newlines to emit individual JSONL lines.
  // Node's data events deliver arbitrary chunks, not line-delimited output.
  let stdoutBuf = "";
  proc.stdout?.on("data", (data: Buffer) => {
    stdoutBuf += data.toString();
    const lines = stdoutBuf.split("\n");
    // Keep the last (potentially incomplete) segment in the buffer
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      output.push(line + "\n");
      const parsed = jsonlParser.parseLine(line);
      events.emit("output", line, parsed);
    }
  });

  // Buffer stderr the same way
  let stderrBuf = "";
  proc.stderr?.on("data", (data: Buffer) => {
    stderrBuf += data.toString();
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      output.push(line + "\n");
      events.emit("output", line, null);
    }
  });

  proc.on("close", (code) => {
    // Flush remaining buffered data
    if (stdoutBuf) {
      output.push(stdoutBuf);
      jsonlParser.parseLine(stdoutBuf);
      events.emit("output", stdoutBuf, null);
    }
    if (stderrBuf) {
      output.push(stderrBuf);
      events.emit("output", stderrBuf, null);
    }

    events.emit("close", code);
    // Finalize parsed output before cleanup
    const instance = activeSandboxes.get(taskId);
    if (instance) {
      instance.parsedOutput = jsonlParser.getResult();
    }
    activeSandboxes.delete(taskId);
  });

  proc.on("error", (err) => {
    events.emit("error", err);
    activeSandboxes.delete(taskId);
  });

  const instance: SandboxInstance = {
    id: taskId,
    process: proc,
    output,
    events,
    workDir: options.projectDir,
    jsonlParser,
  };

  activeSandboxes.set(taskId, instance);
  return instance;
}

export function getSandbox(taskId: string): SandboxInstance | undefined {
  return activeSandboxes.get(taskId);
}

export function sendInput(taskId: string, input: string): boolean {
  const sandbox = activeSandboxes.get(taskId);
  if (!sandbox || !sandbox.process.stdin) return false;
  sandbox.process.stdin.write(input);
  return true;
}

export function stopSandbox(taskId: string): boolean {
  const sandbox = activeSandboxes.get(taskId);
  if (!sandbox) return false;
  sandbox.process.kill("SIGTERM");
  return true;
}

export function listActiveSandboxes(): string[] {
  return Array.from(activeSandboxes.keys());
}
