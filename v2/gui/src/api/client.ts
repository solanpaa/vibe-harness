import type {
  HealthResponse,
  WorkflowRunListResponse,
  WorkflowRunDetailResponse,
  WorkflowRunMessagesResponse,
  ProjectListResponse,
  ProjectDetailResponse,
  ProjectBranchesResponse,
  AgentDefinitionListResponse,
  AgentDefinitionDetailResponse,
  CreateProjectRequest,
  UpdateProjectRequest,
  CreateAgentDefinitionRequest,
  UpdateAgentDefinitionRequest,
  WorkflowTemplateListResponse,
  WorkflowTemplate,
  CreateWorkflowTemplateRequest,
  UpdateWorkflowTemplateRequest,
  WorkspaceSummaryResponse,
  CredentialSetListResponse,
  CredentialSetDetailResponse,
  CreateCredentialSetRequest,
  CreateCredentialEntryRequest,
  CredentialAuditResponse,
  CredentialSet,
  CredentialEntry,
  CreateWorkflowRunRequest,
  WorkflowRun,
  SendInterventionResponse,
  CancelRunResponse,
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
let cachedToken: string | null = null;

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

/** Clear all cached connection state (port + auth token). */
export function resetConnection(): void {
  cachedPort = null;
  cachedToken = null;
}

export async function getAuthToken(): Promise<string | null> {
  if (cachedToken !== null) return cachedToken;
  const token = await readStateFile("auth.token");
  cachedToken = token;
  return token;
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

    // 204 No Content
    if (res.status === 204) {
      return undefined as T;
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

  async getRunMessages(id: string): Promise<WorkflowRunMessagesResponse> {
    return this.fetch<WorkflowRunMessagesResponse>(`/api/runs/${id}/messages`);
  }

  async createRun(data: CreateWorkflowRunRequest): Promise<WorkflowRun> {
    return this.fetch<WorkflowRun>("/api/runs", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async cancelRun(id: string): Promise<CancelRunResponse> {
    return this.fetch<CancelRunResponse>(`/api/runs/${id}/cancel`, {
      method: "POST",
    });
  }

  async sendIntervention(runId: string, message: string): Promise<SendInterventionResponse> {
    return this.fetch<SendInterventionResponse>(`/api/runs/${runId}/message`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }

  // ── Projects ──────────────────────────────────────────────────────

  async listProjects(): Promise<ProjectListResponse> {
    return this.fetch<ProjectListResponse>("/api/projects");
  }

  async getProject(id: string): Promise<ProjectDetailResponse> {
    return this.fetch<ProjectDetailResponse>(`/api/projects/${id}`);
  }

  async createProject(data: CreateProjectRequest): Promise<ProjectDetailResponse> {
    return this.fetch<ProjectDetailResponse>("/api/projects", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateProject(id: string, data: UpdateProjectRequest): Promise<ProjectDetailResponse> {
    return this.fetch<ProjectDetailResponse>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async deleteProject(id: string): Promise<void> {
    return this.fetch<void>(`/api/projects/${id}`, { method: "DELETE" });
  }

  async getProjectBranches(id: string): Promise<ProjectBranchesResponse> {
    return this.fetch<ProjectBranchesResponse>(`/api/projects/${id}/branches`);
  }

  // ── Agents ────────────────────────────────────────────────────────

  async listAgents(): Promise<AgentDefinitionListResponse> {
    return this.fetch<AgentDefinitionListResponse>("/api/agents");
  }

  async getAgent(id: string): Promise<AgentDefinitionDetailResponse> {
    return this.fetch<AgentDefinitionDetailResponse>(`/api/agents/${id}`);
  }

  async createAgent(data: CreateAgentDefinitionRequest): Promise<AgentDefinitionDetailResponse> {
    return this.fetch<AgentDefinitionDetailResponse>("/api/agents", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateAgent(id: string, data: UpdateAgentDefinitionRequest): Promise<AgentDefinitionDetailResponse> {
    return this.fetch<AgentDefinitionDetailResponse>(`/api/agents/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteAgent(id: string): Promise<void> {
    return this.fetch<void>(`/api/agents/${id}`, { method: "DELETE" });
  }

  // ── Workflow Templates ────────────────────────────────────────────

  async listWorkflowTemplates(): Promise<WorkflowTemplateListResponse> {
    return this.fetch<WorkflowTemplateListResponse>("/api/workflows");
  }

  async getWorkflowTemplate(id: string): Promise<WorkflowTemplate> {
    return this.fetch<WorkflowTemplate>(`/api/workflows/${id}`);
  }

  async createWorkflowTemplate(data: CreateWorkflowTemplateRequest): Promise<WorkflowTemplate> {
    return this.fetch<WorkflowTemplate>("/api/workflows", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateWorkflowTemplate(id: string, data: UpdateWorkflowTemplateRequest): Promise<WorkflowTemplate> {
    return this.fetch<WorkflowTemplate>(`/api/workflows/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteWorkflowTemplate(id: string): Promise<void> {
    await this.fetch<void>(`/api/workflows/${id}`, { method: "DELETE" });
  }

  // ── Credentials ──────────────────────────────────────────────────────

  async listCredentialSets(projectId?: string): Promise<CredentialSetListResponse> {
    const params = projectId ? `?projectId=${projectId}` : "";
    return this.fetch<CredentialSetListResponse>(`/api/credentials${params}`);
  }

  async getCredentialSet(id: string): Promise<CredentialSetDetailResponse> {
    return this.fetch<CredentialSetDetailResponse>(`/api/credentials/${id}`);
  }

  async createCredentialSet(data: CreateCredentialSetRequest): Promise<CredentialSet> {
    return this.fetch<CredentialSet>("/api/credentials", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async deleteCredentialSet(id: string): Promise<void> {
    await this.fetch<void>(`/api/credentials/${id}`, { method: "DELETE" });
  }

  async addCredentialEntry(setId: string, data: CreateCredentialEntryRequest): Promise<CredentialEntry> {
    return this.fetch<CredentialEntry>(`/api/credentials/${setId}/entries`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async deleteCredentialEntry(setId: string, entryId: string): Promise<void> {
    await this.fetch<void>(`/api/credentials/${setId}/entries/${entryId}`, { method: "DELETE" });
  }

  async getCredentialAuditLog(credentialSetId?: string): Promise<CredentialAuditResponse> {
    const params = credentialSetId ? `?credentialSetId=${credentialSetId}` : "";
    return this.fetch<CredentialAuditResponse>(`/api/credentials/audit${params}`);
  }
}
