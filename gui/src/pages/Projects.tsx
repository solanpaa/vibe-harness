import { useState, useEffect, useCallback } from "react";
import { useDaemonStore } from "../stores/daemon";
import type {
  Project,
  CreateProjectRequest,
  ProjectBranchesResponse,
} from "@vibe-harness/shared";

// ── Add Project Form ────────────────────────────────────────────────

function AddProjectForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { client } = useDaemonStore();
  const [localPath, setLocalPath] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sandboxMemory, setSandboxMemory] = useState("");
  const [sandboxCpus, setSandboxCpus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Auto-derive name from path
  useEffect(() => {
    if (localPath && !name) {
      const parts = localPath.replace(/\/+$/, "").split("/");
      const derived = parts[parts.length - 1] || "";
      setName(derived);
    }
  }, [localPath, name]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) return;

    setError(null);
    setSubmitting(true);

    try {
      const data: CreateProjectRequest = {
        name: name.trim(),
        localPath: localPath.trim(),
      };
      if (description.trim()) data.description = description.trim();
      if (sandboxMemory.trim()) data.sandboxMemory = sandboxMemory.trim();
      if (sandboxCpus.trim()) {
        const n = Number(sandboxCpus);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
          setError("CPUs must be a non-negative integer (0 = sbx auto)");
          setSubmitting(false);
          return;
        }
        data.sandboxCpus = n;
      }

      await client.createProject(data);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-card border border-border rounded-lg p-4 mb-4 space-y-3"
    >
      <h3 className="text-sm font-semibold text-foreground">Add Project</h3>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Local Path <span className="text-destructive">*</span>
        </label>
        <input
          type="text"
          value={localPath}
          onChange={(e) => setLocalPath(e.target.value)}
          placeholder="/path/to/git/repo"
          className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary"
          required
        />
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Name <span className="text-destructive">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-project"
          className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary"
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

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">
            Sandbox memory
          </label>
          <input
            type="text"
            value={sandboxMemory}
            onChange={(e) => setSandboxMemory(e.target.value)}
            placeholder="e.g. 8g"
            pattern="[1-9][0-9]*[mMgG]"
            title="Binary size, e.g. 1024m or 8g"
            className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary"
          />
          <p className="text-[10px] text-muted-foreground mt-0.5">Leave blank for sbx default (~50% host RAM, max 32g).</p>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">
            Sandbox CPUs
          </label>
          <input
            type="number"
            min={0}
            step={1}
            value={sandboxCpus}
            onChange={(e) => setSandboxCpus(e.target.value)}
            placeholder="e.g. 4"
            className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary"
          />
          <p className="text-[10px] text-muted-foreground mt-0.5">0 or blank = sbx auto (host CPUs − 1).</p>
        </div>
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          {submitting ? "Adding…" : "Add Project"}
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

// ── Project Row ─────────────────────────────────────────────────────

function ProjectRow({
  project,
  onDelete,
}: {
  project: Project;
  onDelete: (id: string) => void;
}) {
  const { client } = useDaemonStore();
  const [expanded, setExpanded] = useState(false);
  const [branches, setBranches] = useState<ProjectBranchesResponse | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [ghAccounts, setGhAccounts] = useState<Array<{ username: string; hostname: string; isActive: boolean }>>([]);
  const [ghAccount, setGhAccount] = useState<string>(project.ghAccount || "");
  const [savingGhAccount, setSavingGhAccount] = useState(false);
  const [sandboxMemory, setSandboxMemory] = useState<string>(project.sandboxMemory ?? "");
  const [sandboxCpus, setSandboxCpus] = useState<string>(
    project.sandboxCpus !== null && project.sandboxCpus !== undefined ? String(project.sandboxCpus) : "",
  );
  const [savingResources, setSavingResources] = useState(false);
  const [resourcesError, setResourcesError] = useState<string | null>(null);

  const loadBranches = useCallback(async () => {
    if (!client || branches) return;
    setLoadingBranches(true);
    try {
      const data = await client.getProjectBranches(project.id);
      setBranches(data);
    } catch {
      // silently fail
    } finally {
      setLoadingBranches(false);
    }
  }, [client, project.id, branches]);

  useEffect(() => {
    if (!expanded || !client || ghAccounts.length > 0) return;
    client.listGhAccounts().then((res) => setGhAccounts(res.accounts)).catch(() => {});
  }, [expanded, client, ghAccounts.length]);

  const handleGhAccountChange = async (value: string) => {
    if (!client) return;
    setSavingGhAccount(true);
    try {
      await client.updateProject(project.id, { ghAccount: value || null });
      setGhAccount(value);
    } catch {
      // silently fail
    } finally {
      setSavingGhAccount(false);
    }
  };

  const handleSaveResources = async () => {
    if (!client) return;
    setResourcesError(null);

    const memTrim = sandboxMemory.trim();
    const cpuTrim = sandboxCpus.trim();
    let cpusValue: number | null = null;
    if (cpuTrim) {
      const n = Number(cpuTrim);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        setResourcesError("CPUs must be a non-negative integer");
        return;
      }
      cpusValue = n;
    }
    if (memTrim && !/^[1-9]\d*[mMgG]$/.test(memTrim)) {
      setResourcesError("Memory must look like 1024m or 8g");
      return;
    }

    setSavingResources(true);
    try {
      await client.updateProject(project.id, {
        sandboxMemory: memTrim || null,
        sandboxCpus: cpusValue,
      });
    } catch (err) {
      setResourcesError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingResources(false);
    }
  };

  const handleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) loadBranches();
  };

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden hover:bg-accent/50 transition-colors">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer"
        onClick={handleExpand}
      >
        <span className="text-xs text-muted-foreground">{expanded ? "▼" : "▶"}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">{project.name}</div>
          <div className="font-mono text-xs text-muted-foreground truncate">
            {project.localPath}
          </div>
          {project.description && (
            <div className="text-xs text-muted-foreground mt-0.5">{project.description}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {project.gitUrl && (
            <span className="font-mono text-xs text-muted-foreground truncate max-w-48">
              {project.gitUrl}
            </span>
          )}
          {confirmDelete ? (
            <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => onDelete(project.id)}
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
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(true);
              }}
              className="text-xs text-muted-foreground hover:text-destructive transition-colors"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <h4 className="text-xs font-semibold text-muted-foreground mb-2">Branches</h4>
          {loadingBranches ? (
            <p className="text-xs text-muted-foreground">Loading branches…</p>
          ) : branches ? (
            branches.branches.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {branches.branches.map((b) => (
                  <span
                    key={b.name}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded font-mono ${
                      b.isCurrent
                        ? "bg-primary/15 text-primary border border-primary/30"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {b.name}
                    {b.lastCommit && (
                      <span className="text-muted-foreground">{b.lastCommit}</span>
                    )}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No branches found</p>
            )
          ) : (
            <p className="text-xs text-muted-foreground">Failed to load branches</p>
          )}
          <div className="mt-3 pt-3 border-t border-border">
            <h4 className="text-xs font-semibold text-muted-foreground mb-2">GitHub Account</h4>
            <div className="flex items-center gap-3">
              <select
                value={ghAccount}
                onChange={(e) => handleGhAccountChange(e.target.value)}
                disabled={savingGhAccount}
                className="bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
              >
                <option value="">Default (from settings)</option>
                {ghAccounts.map((acc) => (
                  <option key={acc.username} value={acc.username}>
                    {acc.username}{acc.isActive ? " (active)" : ""} — {acc.hostname}
                  </option>
                ))}
              </select>
              {savingGhAccount && <span className="text-xs text-muted-foreground">Saving…</span>}
            </div>
          </div>
          <div className="mt-3 pt-3 border-t border-border">
            <h4 className="text-xs font-semibold text-muted-foreground mb-2">Sandbox VM Defaults</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-muted-foreground mb-1">Memory</label>
                <input
                  type="text"
                  value={sandboxMemory}
                  onChange={(e) => setSandboxMemory(e.target.value)}
                  placeholder="e.g. 8g"
                  className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-[11px] text-muted-foreground mb-1">CPUs</label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={sandboxCpus}
                  onChange={(e) => setSandboxCpus(e.target.value)}
                  placeholder="e.g. 4"
                  className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={handleSaveResources}
                disabled={savingResources}
                className="px-2.5 py-1 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors"
              >
                {savingResources ? "Saving…" : "Save"}
              </button>
              {resourcesError && <span className="text-xs text-destructive">{resourcesError}</span>}
              <span className="text-[10px] text-muted-foreground ml-auto">
                Blank = sbx defaults. Per-run overrides available in New Run.
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────

export function Projects() {
  const { client, connected } = useDaemonStore();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const data = await client.listProjects();
      setProjects(data.projects);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (connected) loadProjects();
  }, [connected, loadProjects]);

  const handleDelete = async (id: string) => {
    if (!client) return;
    try {
      await client.deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete project");
    }
  };

  if (!connected) {
    return (
      <div className="p-6 max-w-4xl h-full overflow-y-auto">
        <h1 className="text-sm font-medium text-foreground mb-4">Projects</h1>
        <p className="text-muted-foreground">
          Daemon not connected. Start the daemon to manage projects.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl h-full flex flex-col">
      <h1 className="text-sm font-medium text-foreground mb-6">Projects</h1>

      {showAddForm && (
        <AddProjectForm
          onCreated={() => {
            setShowAddForm(false);
            loadProjects();
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {error && (
        <div className="mb-3 px-3 py-2 bg-destructive/10 border border-destructive/30 rounded text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-2">
        {loading ? (
          <p className="text-muted-foreground text-sm">Loading projects…</p>
        ) : projects.length === 0 && !showAddForm ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground mb-3">No projects registered yet.</p>
            <button
              onClick={() => setShowAddForm(true)}
              className="text-sm text-primary hover:text-primary/80 transition-colors"
            >
              Add your first project →
            </button>
          </div>
        ) : (
          <>
            {projects.map((p) => (
              <ProjectRow key={p.id} project={p} onDelete={handleDelete} />
            ))}
            {!showAddForm && (
              <button
                onClick={() => setShowAddForm(true)}
                className="w-full p-4 rounded-lg border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors text-sm flex items-center justify-center gap-2"
              >
                <span>+</span> Add project
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
