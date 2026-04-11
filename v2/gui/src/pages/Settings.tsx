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
      className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 mb-4 space-y-3"
    >
      <h3 className="text-sm font-semibold text-zinc-200">Add Custom Agent</h3>

      <div>
        <label className="block text-xs text-zinc-400 mb-1">
          Name <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Custom Agent"
          className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
          required
        />
      </div>

      <div>
        <label className="block text-xs text-zinc-400 mb-1">
          Command Template <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={commandTemplate}
          onChange={(e) => setCommandTemplate(e.target.value)}
          placeholder="copilot-cli"
          className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500 font-mono"
          required
        />
      </div>

      <div>
        <label className="block text-xs text-zinc-400 mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
          className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
        />
      </div>

      <div>
        <label className="block text-xs text-zinc-400 mb-1">
          Docker Image
        </label>
        <input
          type="text"
          value={dockerImage}
          onChange={(e) => setDockerImage(e.target.value)}
          placeholder="ghcr.io/owner/image:tag"
          className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500 font-mono"
        />
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white transition-colors"
        >
          {submitting ? "Adding…" : "Add Agent"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-300 transition-colors"
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
    <div className="bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-200">{agent.name}</span>
          <span className="px-1.5 py-0.5 text-xs rounded bg-zinc-700 text-zinc-400 font-mono">
            {agent.type}
          </span>
          {agent.isBuiltIn && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-amber-600/20 text-amber-300 border border-amber-500/30">
              Built-in
            </span>
          )}
        </div>
        {agent.description && (
          <div className="text-xs text-zinc-400 mt-0.5">{agent.description}</div>
        )}
        <div className="text-xs text-zinc-500 font-mono mt-0.5">
          {agent.commandTemplate}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-zinc-500">
        {agent.supportsStreaming && <span title="Streaming">🔄</span>}
        {agent.supportsContinue && <span title="Continue">⏩</span>}
        {agent.supportsIntervention && <span title="Intervention">✋</span>}
      </div>

      {!agent.isBuiltIn && (
        confirmDelete ? (
          <div className="flex gap-1">
            <button
              onClick={() => onDelete(agent.id)}
              className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 rounded text-white"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-300"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="px-2 py-1 text-xs bg-zinc-700 hover:bg-red-600/80 rounded text-zinc-400 hover:text-white transition-colors"
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
      <div>
        <h1 className="text-xl font-semibold text-zinc-200 mb-4">Settings</h1>
        <p className="text-zinc-500">
          Daemon not connected. Start the daemon to manage settings.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <h1 className="text-xl font-semibold text-zinc-200 mb-6">Settings</h1>

      {/* Agent Definitions Section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-medium text-zinc-300">
            Agent Definitions
          </h2>
          {!showAddForm && (
            <button
              onClick={() => setShowAddForm(true)}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded text-white transition-colors"
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
          <div className="mb-3 px-3 py-2 bg-red-900/30 border border-red-800 rounded text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="space-y-2">
          {loading ? (
            <p className="text-zinc-500 text-sm">Loading agents…</p>
          ) : agents.length === 0 ? (
            <p className="text-zinc-500 text-sm">No agent definitions found.</p>
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
