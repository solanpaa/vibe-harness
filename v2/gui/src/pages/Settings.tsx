import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
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
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

// ── GitHub Account Selector ──────────────────────────────────────────

function GhAccountSelector() {
  const { client } = useDaemonStore();
  const [accounts, setAccounts] = useState<Array<{ username: string; hostname: string; isActive: boolean }>>([]);
  const [defaultAccount, setDefaultAccount] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    setLoading(true);
    Promise.all([
      client.listGhAccounts(),
      client.getSettings(),
    ]).then(([ghData, settingsData]) => {
      setAccounts(ghData.accounts);
      setDefaultAccount(settingsData.settings.defaultGhAccount || "");
    }).catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to load accounts");
    }).finally(() => {
      setLoading(false);
    });
  }, [client]);

  const handleChange = async (value: string) => {
    if (!client) return;
    setSaving(true);
    setError(null);
    try {
      await client.updateSettings({
        settings: { defaultGhAccount: value },
      });
      setDefaultAccount(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save setting");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-muted-foreground text-sm">Loading accounts…</p>;
  }

  if (accounts.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No GitHub accounts found. Run <code className="text-xs bg-muted px-1 py-0.5 rounded">gh auth login</code> to add accounts.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <label className="text-sm text-muted-foreground whitespace-nowrap">Default Account</label>
        <select
          value={defaultAccount}
          onChange={(e) => handleChange(e.target.value)}
          disabled={saving}
          className="bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
        >
          <option value="">Auto (active account)</option>
          {accounts.map((acc) => (
            <option key={acc.username} value={acc.username}>
              {acc.username}{acc.isActive ? " (active)" : ""} — {acc.hostname}
            </option>
          ))}
        </select>
        {saving && <span className="text-xs text-muted-foreground">Saving…</span>}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        Controls which <code className="bg-muted px-1 py-0.5 rounded">gh</code> CLI account is used for GitHub tokens. Can be overridden per project or per run.
      </p>
    </div>
  );
}

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

// ── Autostart Toggle ─────────────────────────────────────────────────

function AutostartToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    isAutostartEnabled()
      .then(setEnabled)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggle = async () => {
    setLoading(true);
    try {
      if (enabled) {
        await disableAutostart();
        setEnabled(false);
      } else {
        await enableAutostart();
        setEnabled(true);
      }
    } catch (err) {
      console.error("Autostart toggle failed:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 flex items-center justify-between">
      <div>
        <div className="text-sm font-medium text-foreground">Launch at login</div>
        <div className="text-xs text-muted-foreground">Start Vibe Harness automatically when you log in</div>
      </div>
      <button
        onClick={toggle}
        disabled={loading}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          enabled ? "bg-blue-600" : "bg-muted"
        } ${loading ? "opacity-50" : ""}`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
            enabled ? "translate-x-[18px]" : "translate-x-[3px]"
          }`}
        />
      </button>
    </div>
  );
}

// ── Notification Toggle ──────────────────────────────────────────────

function NotificationToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [permStatus, setPermStatus] = useState<string | null>(null);

  useEffect(() => {
    // Check if notifications are enabled (stored in localStorage as a simple flag)
    const stored = localStorage.getItem("vibe-notifications-enabled");
    setEnabled(stored === "true");

    isPermissionGranted()
      .then((granted) => setPermStatus(granted ? "granted" : "denied"))
      .catch(() => setPermStatus("unknown"))
      .finally(() => setLoading(false));
  }, []);

  const toggle = async () => {
    if (!enabled) {
      // Enabling — request permission if needed
      const granted = await isPermissionGranted();
      if (!granted) {
        const perm = await requestPermission();
        setPermStatus(perm);
        if (perm !== "granted") return;
      }
      setEnabled(true);
      localStorage.setItem("vibe-notifications-enabled", "true");
      // Send test notification
      sendNotification({
        title: "Vibe Harness",
        body: "Notifications enabled! You'll be notified when reviews are ready.",
      });
    } else {
      setEnabled(false);
      localStorage.setItem("vibe-notifications-enabled", "false");
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 flex items-center justify-between">
      <div>
        <div className="text-sm font-medium text-foreground">Desktop notifications</div>
        <div className="text-xs text-muted-foreground">
          Notify when a run needs review or completes
          {permStatus === "denied" && (
            <span className="text-amber-400 ml-1">(permission required)</span>
          )}
        </div>
      </div>
      <button
        onClick={toggle}
        disabled={loading}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          enabled ? "bg-blue-600" : "bg-muted"
        } ${loading ? "opacity-50" : ""}`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
            enabled ? "translate-x-[18px]" : "translate-x-[3px]"
          }`}
        />
      </button>
    </div>
  );
}

function SplitSettingsSection() {
  const { client } = useDaemonStore();
  const [promptTemplate, setPromptTemplate] = useState<string>("");
  const [postSplitStagesJson, setPostSplitStagesJson] = useState<string>("[]");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const resp = await client.getSettings();
      const s = resp.settings ?? {};
      setPromptTemplate(s["defaultSplitterPromptTemplate"] ?? "");
      const post = s["defaultPostSplitStages"];
      if (typeof post === "string" && post.trim()) {
        try {
          setPostSplitStagesJson(JSON.stringify(JSON.parse(post), null, 2));
        } catch {
          setPostSplitStagesJson(post);
        }
      } else {
        setPostSplitStagesJson("[]");
      }
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!client) return;
    setSaving(true);
    setMsg(null);
    try {
      let postParsed: unknown;
      try {
        postParsed = JSON.parse(postSplitStagesJson || "[]");
      } catch (err) {
        setMsg({ ok: false, text: `Post-split stages JSON invalid: ${err instanceof Error ? err.message : String(err)}` });
        setSaving(false);
        return;
      }
      await client.updateSettings({
        settings: {
          defaultSplitterPromptTemplate: promptTemplate,
          defaultPostSplitStages: JSON.stringify(postParsed),
        },
      });
      setMsg({ ok: true, text: "Saved." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Failed to save" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>;

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Default splitter prompt template
        </label>
        <textarea
          value={promptTemplate}
          onChange={(e) => setPromptTemplate(e.target.value)}
          rows={6}
          placeholder="Used when the user triggers a Split from a review. Supports {{description}} and {{extra}} placeholders."
          className="w-full px-2 py-1.5 text-sm rounded bg-background border border-border text-foreground focus:border-primary focus:outline-none font-mono"
        />
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Default post-split stages (JSON array of WorkflowStage)
        </label>
        <textarea
          value={postSplitStagesJson}
          onChange={(e) => setPostSplitStagesJson(e.target.value)}
          rows={8}
          placeholder='[]'
          className="w-full px-2 py-1.5 text-xs rounded bg-background border border-border text-foreground focus:border-primary focus:outline-none font-mono"
          spellCheck={false}
        />
        <p className="text-[11px] text-muted-foreground mt-1">
          Runs after consolidation review on every ad-hoc split. Stages here
          cannot be splittable themselves.
        </p>
      </div>

      {msg && (
        <div
          className={`px-2 py-1.5 text-xs rounded border ${
            msg.ok
              ? "bg-green-950/30 border-green-800/50 text-green-400"
              : "bg-destructive/10 border-destructive/30 text-destructive"
          }`}
        >
          {msg.text}
        </div>
      )}

      <button
        onClick={save}
        disabled={saving}
        className="px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
      >
        {saving ? "Saving…" : "Save split settings"}
      </button>
    </div>
  );
}

export function Settings() {
  const { client, connected } = useDaemonStore();
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const agentRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  // Deep-link support: when navigated to /settings?agent=<id> (e.g. from the
  // NewRunModal "Build image" button), auto-expand and scroll to that agent
  // once its row has rendered. We consume the query param so subsequent edits
  // to the same page don't re-trigger the scroll.
  useEffect(() => {
    const focusAgent = searchParams.get("agent");
    if (!focusAgent || agents.length === 0) return;
    if (!agents.some((a) => a.id === focusAgent)) return;
    setExpandedAgentId(focusAgent);
    requestAnimationFrame(() => {
      agentRefs.current.get(focusAgent)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    // Strip the query param so reloads don't keep re-focusing.
    const next = new URLSearchParams(searchParams);
    next.delete("agent");
    setSearchParams(next, { replace: true });
  }, [agents, searchParams, setSearchParams]);

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
      <div className="p-6 max-w-4xl h-full overflow-y-auto">
        <h1 className="text-sm font-medium text-foreground mb-4">Settings</h1>
        <p className="text-muted-foreground">
          Daemon not connected. Start the daemon to manage settings.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl h-full flex flex-col overflow-y-auto">
      <h1 className="text-sm font-medium text-foreground mb-6">Settings</h1>

      {/* App Preferences Section */}
      <section className="mb-8">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
          App Preferences
        </h2>
        <div className="space-y-2">
          <AutostartToggle />
          <NotificationToggle />
        </div>
      </section>

      {/* GitHub Account Section */}
      <section className="mb-8">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
          GitHub Account
        </h2>
        <GhAccountSelector />
      </section>

      {/* Split Execution Section */}
      <section className="mb-8">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
          Split Execution
        </h2>
        <SplitSettingsSection />
      </section>

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
                <div
                  key={a.id}
                  ref={(el) => { agentRefs.current.set(a.id, el); }}
                >
                  <AgentRow
                    agent={a}
                    onDelete={handleDelete}
                    onUpdated={loadAgents}
                    isExpanded={expandedAgentId === a.id}
                    onToggle={() => setExpandedAgentId(expandedAgentId === a.id ? null : a.id)}
                  />
                </div>
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
