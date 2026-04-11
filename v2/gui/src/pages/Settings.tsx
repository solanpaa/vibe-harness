import { useState, useEffect, useCallback } from "react";
import { useDaemonStore } from "../stores/daemon";
import type {
  AgentDefinition,
  CreateAgentDefinitionRequest,
} from "@vibe-harness/shared";
import {
  Terminal,
  TerminalHeader,
  TerminalTitle,
  TerminalContent,
  TerminalClearButton,
  TerminalActions,
} from "@/components/ai-elements/terminal";

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

// ── Agent Row (expandable with Dockerfile editor + build) ───────────

interface ImageStatus {
  exists: boolean;
  image: string | null;
  imageId?: string;
  created?: string;
  sizeMB?: number;
}

function AgentRow({
  agent,
  onDelete,
  onUpdated,
  isExpanded,
  onToggle,
}: {
  agent: AgentDefinition;
  onDelete: (id: string) => void;
  onUpdated: () => void;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { client } = useDaemonStore();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Editable fields (for expanded view)
  const [editDockerImage, setEditDockerImage] = useState(agent.dockerImage ?? "");
  const [editDockerfile, setEditDockerfile] = useState(agent.dockerfile ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Image status
  const [imageStatus, setImageStatus] = useState<ImageStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  // Build state
  const [buildOutput, setBuildOutput] = useState("");
  const [isBuilding, setIsBuilding] = useState(false);

  // Reset edit fields when agent changes
  useEffect(() => {
    setEditDockerImage(agent.dockerImage ?? "");
    setEditDockerfile(agent.dockerfile ?? "");
  }, [agent.dockerImage, agent.dockerfile]);

  // Load image status when expanded
  useEffect(() => {
    if (!isExpanded || !client) return;
    setLoadingStatus(true);
    client.getAgentImageStatus(agent.id)
      .then(setImageStatus)
      .catch(() => setImageStatus(null))
      .finally(() => setLoadingStatus(false));
  }, [isExpanded, client, agent.id]);

  const handleSaveDocker = async () => {
    if (!client) return;
    setSaving(true);
    setSaveError(null);
    try {
      await client.updateAgent(agent.id, {
        dockerImage: editDockerImage.trim() || undefined,
        dockerfile: editDockerfile.trim() || undefined,
      });
      onUpdated();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleBuild = async () => {
    if (!client) return;
    setIsBuilding(true);
    setBuildOutput("");
    await client.buildAgentImage(
      agent.id,
      (text) => setBuildOutput((prev) => prev + text),
      (success) => {
        setIsBuilding(false);
        if (success) {
          // Refresh image status
          client.getAgentImageStatus(agent.id)
            .then(setImageStatus)
            .catch(() => {});
        }
      },
    );
  };

  const hasDirtyDocker =
    (editDockerImage.trim() || "") !== (agent.dockerImage ?? "") ||
    (editDockerfile.trim() || "") !== (agent.dockerfile ?? "");

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Collapsed header row */}
      <div
        className="px-4 py-3 flex items-center gap-3 hover:bg-accent/50 transition-colors cursor-pointer"
        onClick={onToggle}
      >
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

        <div className="flex items-center gap-1.5 flex-wrap">
          {agent.supportsStreaming && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">streaming</span>
          )}
          {agent.supportsContinue && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">continue</span>
          )}
          {agent.supportsIntervention && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">intervention</span>
          )}
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{agent.outputFormat}</span>
        </div>

        {!agent.isBuiltIn && (
          <div onClick={(e) => e.stopPropagation()}>
            {confirmDelete ? (
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
            )}
          </div>
        )}

        <span className="text-muted-foreground text-xs">{isExpanded ? "▲" : "▼"}</span>
      </div>

      {/* Expanded detail view */}
      {isExpanded && (
        <div className="border-t border-border px-4 py-4 space-y-4">
          {/* Docker Image Name */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <label className="block text-xs text-muted-foreground">Docker Image</label>
              {loadingStatus ? (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">checking…</span>
              ) : imageStatus?.exists ? (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-950/50 text-green-400">
                  ✓ Available ({imageStatus.sizeMB}MB)
                </span>
              ) : agent.dockerImage ? (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  Not built
                </span>
              ) : null}
            </div>
            <input
              type="text"
              value={editDockerImage}
              onChange={(e) => setEditDockerImage(e.target.value)}
              placeholder="my-agent:latest"
              className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary font-mono"
            />
          </div>

          {/* Dockerfile Editor */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Dockerfile</label>
            <textarea
              value={editDockerfile}
              onChange={(e) => setEditDockerfile(e.target.value)}
              placeholder={"FROM ubuntu:22.04\nRUN apt-get update && apt-get install -y ..."}
              rows={12}
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary font-mono leading-relaxed resize-y"
              spellCheck={false}
            />
          </div>

          {saveError && <p className="text-xs text-destructive">{saveError}</p>}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveDocker}
              disabled={saving || !hasDirtyDocker}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={handleBuild}
              disabled={isBuilding || !agent.dockerfile || !agent.dockerImage}
              className="px-3 py-1.5 text-sm bg-green-700 text-white rounded-md hover:bg-green-600 disabled:opacity-50 transition-colors"
            >
              {isBuilding ? "Building…" : "Build Image"}
            </button>
            {hasDirtyDocker && !saving && (
              <span className="text-xs text-muted-foreground">Unsaved changes — save before building</span>
            )}
          </div>

          {/* Build output terminal */}
          {(buildOutput || isBuilding) && (
            <Terminal output={buildOutput} isStreaming={isBuilding} onClear={() => setBuildOutput("")}>
              <TerminalHeader>
                <TerminalTitle>Docker Build</TerminalTitle>
                <TerminalActions>
                  <TerminalClearButton />
                </TerminalActions>
              </TerminalHeader>
              <TerminalContent />
            </Terminal>
          )}
        </div>
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
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);

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
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
          Agent Definitions
        </h2>

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
          ) : agents.length === 0 && !showAddForm ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground mb-3">No custom agent definitions yet.</p>
              <button
                onClick={() => setShowAddForm(true)}
                className="text-sm text-primary hover:text-primary/80 transition-colors"
              >
                Register your first agent →
              </button>
            </div>
          ) : (
            <>
              {agents.map((a) => (
                <AgentRow
                  key={a.id}
                  agent={a}
                  onDelete={handleDelete}
                  onUpdated={loadAgents}
                  isExpanded={expandedAgentId === a.id}
                  onToggle={() => setExpandedAgentId(expandedAgentId === a.id ? null : a.id)}
                />
              ))}
              {!showAddForm && (
                <button
                  onClick={() => setShowAddForm(true)}
                  className="w-full p-4 rounded-lg border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors text-sm flex items-center justify-center gap-2"
                >
                  <span>+</span> Add agent
                </button>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
