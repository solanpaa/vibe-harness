import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { buildSandboxCredentials } from "./credential-vault";

export interface SandboxOptions {
  projectDir: string;
  agentCommand: string;
  credentialSetId?: string | null;
  prompt?: string;
}

export interface SandboxInstance {
  id: string;
  process: ChildProcess;
  output: string[];
  events: EventEmitter;
}

const activeSandboxes = new Map<string, SandboxInstance>();

/**
 * Build the full command + env for launching an agent in a Docker sandbox.
 * Uses `docker sandbox run` with credential injection.
 */
function buildSandboxCommand(options: SandboxOptions): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const args: string[] = ["sandbox", "run"];
  const env = { ...process.env };

  // Inject credentials
  if (options.credentialSetId) {
    const creds = buildSandboxCredentials(options.credentialSetId);
    for (const [key, value] of Object.entries(creds.envVars)) {
      args.push("--env", `${key}=${value}`);
    }
    for (const mount of creds.fileMounts) {
      args.push("--mount", `${mount.key}:${mount.value}`);
    }
  }

  // Mount project directory
  args.push("--mount", `${options.projectDir}:${options.projectDir}`);

  // Agent command (e.g., "copilot" for docker sandbox run copilot)
  args.push(options.agentCommand);

  // Project directory
  args.push(options.projectDir);

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
