import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { buildSandboxCredentials } from "./credential-vault";

export interface SandboxOptions {
  projectDir: string;
  agentCommand: string;
  credentialSetId?: string | null;
  dockerImage?: string | null;
  prompt?: string;
  agentArgs?: string[];
  sandboxName?: string;
}

export interface SandboxInstance {
  id: string;
  process: ChildProcess;
  output: string[];
  events: EventEmitter;
  workDir: string; // actual working directory (may be worktree)
}

const activeSandboxes = new Map<string, SandboxInstance>();

/**
 * Build the command for launching an agent in a Docker sandbox.
 *
 * Syntax: docker sandbox run [OPTIONS] AGENT [WORKSPACE] [EXTRA_WORKSPACE...] [-- AGENT_ARGS...]
 *
 * Credentials (GITHUB_TOKEN, etc.) are picked up from the host's shell
 * environment — Docker Desktop daemon reads them. Credential vault env vars
 * are injected into the spawned process env so the daemon inherits them.
 *
 * See: https://docs.docker.com/ai/sandboxes/agents/copilot/
 */
function buildSandboxCommand(options: SandboxOptions): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const args: string[] = ["sandbox", "run"];
  const env = { ...process.env };

  // Sandbox name (for easy identification)
  if (options.sandboxName) {
    args.push("--name", options.sandboxName);
  }

  // Custom template image (e.g., for custom agent setups)
  if (options.dockerImage) {
    args.push("-t", options.dockerImage);
  }

  // Agent name (e.g., "copilot", "claude", "gemini")
  args.push(options.agentCommand);

  // Workspace directory (positional arg after agent name)
  args.push(options.projectDir);

  // Agent-specific args after -- separator (e.g., "--yolo" for copilot)
  if (options.agentArgs?.length) {
    args.push("--", ...options.agentArgs);
  }

  // Inject credential vault env vars into the process environment
  // so the Docker daemon can pick them up
  if (options.credentialSetId) {
    const creds = buildSandboxCredentials(options.credentialSetId);
    for (const [key, value] of Object.entries(creds.envVars)) {
      env[key] = value;
    }
  }

  return { command: "docker", args, env };
}

/** Launch a Docker sandbox for an agent session */
export function launchSandbox(
  sessionId: string,
  options: SandboxOptions
): SandboxInstance {
  const { command, args, env } = buildSandboxCommand(options);
  const events = new EventEmitter();
  const output: string[] = [];

  const proc = spawn(command, args, {
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

  // If there's a prompt, send it to stdin
  if (options.prompt && proc.stdin) {
    proc.stdin.write(options.prompt + "\n");
  }

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

/** Get an active sandbox by session ID */
export function getSandbox(sessionId: string): SandboxInstance | undefined {
  return activeSandboxes.get(sessionId);
}

/** Send input to an active sandbox */
export function sendInput(sessionId: string, input: string): boolean {
  const sandbox = activeSandboxes.get(sessionId);
  if (!sandbox || !sandbox.process.stdin) return false;
  sandbox.process.stdin.write(input);
  return true;
}

/** Stop a sandbox */
export function stopSandbox(sessionId: string): boolean {
  const sandbox = activeSandboxes.get(sessionId);
  if (!sandbox) return false;
  sandbox.process.kill("SIGTERM");
  setTimeout(() => {
    if (activeSandboxes.has(sessionId)) {
      sandbox.process.kill("SIGKILL");
    }
  }, 5000);
  return true;
}

/** List all active sandbox IDs */
export function listActiveSandboxes(): string[] {
  return Array.from(activeSandboxes.keys());
}
