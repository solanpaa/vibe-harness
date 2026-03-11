import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { buildSandboxCredentials } from "./credential-vault";

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
}

const activeSandboxes = new Map<string, SandboxInstance>();

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
function buildSandboxCommand(options: SandboxOptions): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const args: string[] = ["sandbox", "run"];
  const env = { ...process.env };

  if (options.sandboxName) {
    args.push("--name", options.sandboxName);
  }

  if (options.dockerImage) {
    args.push("-t", options.dockerImage);
  }

  args.push(options.agentCommand);
  args.push(options.projectDir);

  // Agent args after -- separator
  const agentArgs: string[] = ["--yolo"];

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
    const creds = buildSandboxCredentials(options.credentialSetId);
    for (const [key, value] of Object.entries(creds.envVars)) {
      env[key] = value;
    }
  }

  return { command: "docker", args, env };
}

export function launchSandbox(
  sessionId: string,
  options: SandboxOptions
): SandboxInstance {
  const { command, args, env } = buildSandboxCommand(options);
  const events = new EventEmitter();
  const output: string[] = [];

  // Try to get GITHUB_TOKEN from gh CLI if not already set
  if (!env.GITHUB_TOKEN && !env.GH_TOKEN) {
    try {
      const { execSync } = require("child_process");
      const token = execSync("gh auth token", { encoding: "utf-8" }).trim();
      if (token) env.GITHUB_TOKEN = token;
    } catch {
      // gh CLI not available or not authenticated — sandbox will handle auth
    }
  }

  // Use `script` to wrap the command in a PTY so docker sandbox
  // outputs properly (it requires a TTY for interactive output)
  const fullCmd = [command, ...args].map((a) =>
    a.includes(" ") || a.includes('"') ? `'${a.replace(/'/g, "'\\''")}'` : a
  ).join(" ");

  const proc = spawn("script", ["-q", "/dev/null", "/bin/sh", "-c", fullCmd], {
    env,
    cwd: options.projectDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (data: Buffer) => {
    const line = data.toString();
    output.push(line);
    events.emit("output", line);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const line = data.toString();
    output.push(line);
    events.emit("output", line);
  });

  proc.on("close", (code) => {
    events.emit("close", code);
    activeSandboxes.delete(sessionId);
  });

  proc.on("error", (err) => {
    events.emit("error", err);
    activeSandboxes.delete(sessionId);
  });

  const instance: SandboxInstance = {
    id: sessionId,
    process: proc,
    output,
    events,
    workDir: options.projectDir,
  };

  activeSandboxes.set(sessionId, instance);
  return instance;
}

export function getSandbox(sessionId: string): SandboxInstance | undefined {
  return activeSandboxes.get(sessionId);
}

export function sendInput(sessionId: string, input: string): boolean {
  const sandbox = activeSandboxes.get(sessionId);
  if (!sandbox || !sandbox.process.stdin) return false;
  sandbox.process.stdin.write(input);
  return true;
}

export function stopSandbox(sessionId: string): boolean {
  const sandbox = activeSandboxes.get(sessionId);
  if (!sandbox) return false;
  sandbox.process.kill("SIGTERM");
  return true;
}

export function listActiveSandboxes(): string[] {
  return Array.from(activeSandboxes.keys());
}
