import type {
  HealthResponse,
  WorkflowRunListResponse,
  WorkflowRunDetailResponse,
  ProjectListResponse,
  WorkflowTemplateListResponse,
  WorkspaceSummaryResponse,
} from "@vibe-harness/shared";

/** Read a file from ~/.vibe-harness/ via the Tauri FS plugin or `invoke`. */
async function readStateFile(filename: string): Promise<string | null> {
  try {
    // In Tauri context, use invoke to read files from the home directory
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("read_state_file", { filename });
  } catch {
    // Fallback: not in Tauri or command not registered
    return null;
  }
}

let cachedPort: number | null = null;

export async function getDaemonPort(): Promise<number | null> {
  if (cachedPort) return cachedPort;

  // Try reading from the state file
  const portStr = await readStateFile("daemon.port");
  if (portStr) {
    const port = parseInt(portStr.trim(), 10);
    if (!isNaN(port)) {
      cachedPort = port;
      return port;
    }
  }
  return null;
}

export function setCachedPort(port: number): void {
  cachedPort = port;
}

export function clearCachedPort(): void {
  cachedPort = null;
}

async function getAuthToken(): Promise<string | null> {
  return readStateFile("auth.token");
}

export class DaemonClient {
  private baseUrl: string;

  constructor(port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await getAuthToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token.trim()}` } : {}),
    };

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Daemon API error ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  async health(): Promise<HealthResponse> {
    return this.fetch<HealthResponse>("/health");
  }

  async getWorkspaceSummary(): Promise<WorkspaceSummaryResponse> {
    return this.fetch<WorkspaceSummaryResponse>("/api/workspace/summary");
  }

  async listRuns(query?: Record<string, string>): Promise<WorkflowRunListResponse> {
    const params = query ? `?${new URLSearchParams(query)}` : "";
    return this.fetch<WorkflowRunListResponse>(`/api/runs${params}`);
  }

  async getRun(id: string): Promise<WorkflowRunDetailResponse> {
    return this.fetch<WorkflowRunDetailResponse>(`/api/runs/${id}`);
  }

  async listProjects(): Promise<ProjectListResponse> {
    return this.fetch<ProjectListResponse>("/api/projects");
  }

  async listWorkflowTemplates(): Promise<WorkflowTemplateListResponse> {
    return this.fetch<WorkflowTemplateListResponse>("/api/workflow-templates");
  }
}
