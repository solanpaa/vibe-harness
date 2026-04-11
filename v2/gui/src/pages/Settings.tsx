import { useState, useEffect, useCallback } from "react";
import { useDaemonStore } from "../stores/daemon";
import type {
  AgentDefinition,
  CreateAgentDefinitionRequest,
} from "@vibe-harness/shared";

// ── Add Agent Form ──────────────────────────────────────────────────

function AddAgentForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { client } = useDaemonStore();
  const [name, setName] = useState("");
  const [commandTemplate, setCommandTemplate] = useState("");
  const [description, setDescription] = useState("");
  const [dockerImage, setDockerImage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) return;

    setError(null);
    setSubmitting(true);

    try {
      const data: CreateAgentDefinitionRequest = {
        name: name.trim(),
        type: "copilot_cli",
        commandTemplate: commandTemplate.trim(),
      };
      if (description.trim()) data.description = description.trim();
      if (dockerImage.trim()) data.dockerImage = dockerImage.trim();

      await client.createAgent(data);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-card border border-border rounded-lg p-4 mb-4 space-y-3"
    >
      <h3 className="text-sm font-semibold text-foreground">Add Custom Agent</h3>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Name <span className="text-destructive">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Custom Agent"
          className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary"
          required
        />
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Command Template <span className="text-destructive">*</span>
        </label>
        <input
          type="text"
          value={commandTemplate}
          onChange={(e) => setCommandTemplate(e.target.value)}
          placeholder="copilot-cli"
          className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary font-mono"
          required
        />
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
          className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary"
        />
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Docker Image
        </label>
        <input
          type="text"
          value={dockerImage}
          onChange={(e) => setDockerImage(e.target.value)}
          placeholder="ghcr.io/owner/image:tag"
          className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary font-mono"
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          {submitting ? "Adding…" : "Add Agent"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm bg-muted hover:bg-accent rounded-md text-muted-foreground transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Agent Row ───────────────────────────────────────────────────────

function AgentRow({
  agent,
  onDelete,
}: {
  agent: AgentDefinition;
  onDelete: (id: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 flex items-center gap-3 hover:bg-accent/50 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{agent.name}</span>
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
            {agent.type}
          </span>
          {agent.isBuiltIn && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              Built-in
            </span>
          )}
        </div>
        {agent.description && (
          <div className="text-xs text-muted-foreground mt-0.5">{agent.description}</div>
        )}
        <div className="font-mono text-xs text-muted-foreground mt-0.5">
          {agent.commandTemplate}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {agent.supportsStreaming && <span title="Streaming">🔄</span>}
        {agent.supportsContinue && <span title="Continue">⏩</span>}
        {agent.supportsIntervention && <span title="Intervention">✋</span>}
      </div>

      {!agent.isBuiltIn && (
        confirmDelete ? (
          <div className="flex gap-1">
            <button
              onClick={() => onDelete(agent.id)}
              className="px-2 py-0.5 text-xs bg-destructive hover:bg-destructive/90 rounded text-destructive-foreground"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-2 py-0.5 text-xs bg-muted hover:bg-accent rounded text-muted-foreground"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            Delete
          </button>
        )
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────

export function Settings() {
  const { client, connected } = useDaemonStore();
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const data = await client.listAgents();
      setAgents(data.agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (connected) loadAgents();
  }, [connected, loadAgents]);

  const handleDelete = async (id: string) => {
    if (!client) return;
    try {
      await client.deleteAgent(id);
      setAgents((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete agent");
    }
  };

  if (!connected) {
    return (
      <div className="p-6 max-w-4xl">
        <h1 className="text-sm font-medium text-foreground mb-4">Settings</h1>
        <p className="text-muted-foreground">
          Daemon not connected. Start the daemon to manage settings.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl h-full flex flex-col">
      <h1 className="text-sm font-medium text-foreground mb-6">Settings</h1>

      {/* Agent Definitions Section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Agent Definitions
          </h2>
          {!showAddForm && (
            <button
              onClick={() => setShowAddForm(true)}
              className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-500 transition-colors"
            >
              + Add Agent
            </button>
          )}
        </div>

        {showAddForm && (
          <AddAgentForm
            onCreated={() => {
              setShowAddForm(false);
              loadAgents();
            }}
            onCancel={() => setShowAddForm(false)}
          />
        )}

        {error && (
          <div className="mb-3 px-3 py-2 bg-destructive/10 border border-destructive/30 rounded text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-2">
          {loading ? (
            <p className="text-muted-foreground text-sm">Loading agents…</p>
          ) : agents.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">No agent definitions found.</p>
            </div>
          ) : (
            agents.map((a) => (
              <AgentRow key={a.id} agent={a} onDelete={handleDelete} />
            ))
          )}
        </div>
      </section>
    </div>
  );
}
