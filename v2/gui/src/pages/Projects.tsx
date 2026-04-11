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
      className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 mb-4 space-y-3"
    >
      <h3 className="text-sm font-semibold text-zinc-200">Add Project</h3>

      <div>
        <label className="block text-xs text-zinc-400 mb-1">
          Local Path <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={localPath}
          onChange={(e) => setLocalPath(e.target.value)}
          placeholder="/path/to/git/repo"
          className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
          required
        />
      </div>

      <div>
        <label className="block text-xs text-zinc-400 mb-1">
          Name <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-project"
          className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
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

      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white transition-colors"
        >
          {submitting ? "Adding…" : "Add Project"}
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

  const handleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) loadBranches();
  };

  return (
    <div className="bg-zinc-800 border border-zinc-700 rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-zinc-750"
        onClick={handleExpand}
      >
        <span className="text-xs text-zinc-500">{expanded ? "▼" : "▶"}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-zinc-200">{project.name}</div>
          <div className="text-xs text-zinc-500 truncate font-mono">
            {project.localPath}
          </div>
          {project.description && (
            <div className="text-xs text-zinc-400 mt-0.5">{project.description}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {project.gitUrl && (
            <span className="text-xs text-zinc-500 truncate max-w-48">
              {project.gitUrl}
            </span>
          )}
          {confirmDelete ? (
            <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => onDelete(project.id)}
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
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(true);
              }}
              className="px-2 py-1 text-xs bg-zinc-700 hover:bg-red-600/80 rounded text-zinc-400 hover:text-white transition-colors"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-700 px-4 py-3">
          <h4 className="text-xs font-semibold text-zinc-400 mb-2">Branches</h4>
          {loadingBranches ? (
            <p className="text-xs text-zinc-500">Loading branches…</p>
          ) : branches ? (
            branches.branches.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {branches.branches.map((b) => (
                  <span
                    key={b.name}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded font-mono ${
                      b.isCurrent
                        ? "bg-blue-600/20 text-blue-300 border border-blue-500/30"
                        : "bg-zinc-700 text-zinc-400"
                    }`}
                  >
                    {b.name}
                    {b.lastCommit && (
                      <span className="text-zinc-500">{b.lastCommit}</span>
                    )}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-zinc-500">No branches found</p>
            )
          ) : (
            <p className="text-xs text-zinc-500">Failed to load branches</p>
          )}
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
      <div>
        <h1 className="text-xl font-semibold text-zinc-200 mb-4">Projects</h1>
        <p className="text-zinc-500">
          Daemon not connected. Start the daemon to manage projects.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-zinc-200">Projects</h1>
        {!showAddForm && (
          <button
            onClick={() => setShowAddForm(true)}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded text-white transition-colors"
          >
            + Add Project
          </button>
        )}
      </div>

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
        <div className="mb-3 px-3 py-2 bg-red-900/30 border border-red-800 rounded text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-2">
        {loading ? (
          <p className="text-zinc-500 text-sm">Loading projects…</p>
        ) : projects.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-zinc-500 mb-2">No projects registered yet.</p>
            <p className="text-xs text-zinc-600">
              Add a project by pointing to a local git repository.
            </p>
          </div>
        ) : (
          projects.map((p) => (
            <ProjectRow key={p.id} project={p} onDelete={handleDelete} />
          ))
        )}
      </div>
    </div>
  );
}
