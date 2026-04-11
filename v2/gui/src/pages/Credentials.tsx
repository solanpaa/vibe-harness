import { useState, useEffect, useCallback } from "react";
import { useDaemonStore } from "../stores/daemon";
import type {
  CredentialSet,
  CredentialEntry,
  CredentialEntryType,
  CredentialAuditResponse,
} from "@vibe-harness/shared";

// ── Types ──────────────────────────────────────────────────────────────

interface CredentialSetWithCount extends CredentialSet {
  entryCount: number;
}

const ENTRY_TYPES: { value: CredentialEntryType; label: string; description: string }[] = [
  { value: "env_var", label: "Environment Variable", description: "Injected as -e KEY=VALUE" },
  { value: "file_mount", label: "File Mount", description: "File content written to sandbox path" },
  { value: "docker_login", label: "Docker Login", description: "Registry auth (JSON: username/password)" },
  { value: "host_dir_mount", label: "Host Dir Mount", description: "Read-only host directory bind mount" },
  { value: "command_extract", label: "Command Extract", description: "⚠️ Runs shell command on HOST" },
];

// ── Add Credential Set Form ────────────────────────────────────────

function AddSetForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { client } = useDaemonStore();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) return;
    setError(null);
    setSubmitting(true);
    try {
      await client.createCredentialSet({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create set");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 mb-4 space-y-3"
    >
      <h3 className="text-sm font-semibold text-zinc-200">New Credential Set</h3>
      <div>
        <label className="block text-xs text-zinc-400 mb-1">
          Name <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Production API Keys"
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
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white transition-colors"
        >
          {submitting ? "Creating…" : "Create Set"}
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

// ── Add Entry Form ─────────────────────────────────────────────────

function AddEntryForm({
  setId,
  onCreated,
  onCancel,
}: {
  setId: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { client } = useDaemonStore();
  const [type, setType] = useState<CredentialEntryType>("env_var");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [mountPath, setMountPath] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const needsValue = type !== "command_extract";
  const needsMountPath = type === "file_mount" || type === "host_dir_mount";
  const needsCommand = type === "command_extract";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) return;
    setError(null);
    setSubmitting(true);
    try {
      await client.addCredentialEntry(setId, {
        key: key.trim(),
        value: needsValue ? value : undefined,
        type,
        mountPath: needsMountPath ? mountPath.trim() : undefined,
        command: needsCommand ? command.trim() : undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add entry");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-zinc-850 border border-zinc-600 rounded p-3 mt-3 space-y-3"
    >
      <h4 className="text-xs font-semibold text-zinc-300">Add Credential Entry</h4>

      <div>
        <label className="block text-xs text-zinc-400 mb-1">Type</label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as CredentialEntryType)}
          className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-blue-500"
        >
          {ENTRY_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-zinc-500 mt-1">
          {ENTRY_TYPES.find((t) => t.value === type)?.description}
        </p>
      </div>

      <div>
        <label className="block text-xs text-zinc-400 mb-1">
          Key <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={type === "docker_login" ? "registry.example.com" : "API_KEY"}
          className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
          required
        />
      </div>

      {needsValue && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1">
            Value <span className="text-red-400">*</span>
          </label>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              type === "docker_login"
                ? '{"username": "...", "password": "..."}'
                : type === "host_dir_mount"
                  ? "/host/path/to/dir"
                  : "secret value"
            }
            rows={type === "file_mount" || type === "docker_login" ? 4 : 2}
            className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500 font-mono"
            required
          />
        </div>
      )}

      {needsMountPath && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1">
            Mount Path <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={mountPath}
            onChange={(e) => setMountPath(e.target.value)}
            placeholder={type === "host_dir_mount" ? "/container/path" : "/home/user/.config/file"}
            className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500 font-mono"
            required
          />
        </div>
      )}

      {needsCommand && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1">
            Command <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="gcloud auth print-access-token"
            className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500 font-mono"
            required
          />
          <p className="text-xs text-amber-400 mt-1">
            ⚠️ This command runs on your HOST machine, not in the sandbox.
          </p>
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white transition-colors"
        >
          {submitting ? "Adding…" : "Add Entry"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Entry Row ──────────────────────────────────────────────────────

function EntryRow({
  entry,
  setId,
  onDeleted,
}: {
  entry: CredentialEntry;
  setId: string;
  onDeleted: () => void;
}) {
  const { client } = useDaemonStore();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const typeLabel = ENTRY_TYPES.find((t) => t.value === entry.type)?.label ?? entry.type;
  const typeColor =
    entry.type === "command_extract"
      ? "text-amber-400"
      : entry.type === "docker_login"
        ? "text-purple-400"
        : "text-blue-400";

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-zinc-900 rounded text-sm">
      <span className={`text-xs font-mono ${typeColor}`}>{typeLabel}</span>
      <span className="text-zinc-200 font-mono flex-1 truncate">{entry.key}</span>
      {entry.mountPath && (
        <span className="text-xs text-zinc-500 font-mono truncate max-w-48">
          → {entry.mountPath}
        </span>
      )}
      {entry.command && (
        <span className="text-xs text-zinc-500 font-mono truncate max-w-48">
          $ {entry.command}
        </span>
      )}
      <span className="text-xs text-zinc-600 font-mono">•••</span>
      {confirmDelete ? (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={async () => {
              if (client) {
                await client.deleteCredentialEntry(setId, entry.id);
                onDeleted();
              }
            }}
            className="px-2 py-0.5 text-xs bg-red-600 hover:bg-red-500 rounded text-white"
          >
            Confirm
          </button>
          <button
            onClick={() => setConfirmDelete(false)}
            className="px-2 py-0.5 text-xs bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-300"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirmDelete(true)}
          className="px-2 py-0.5 text-xs bg-zinc-700 hover:bg-red-600/80 rounded text-zinc-400 hover:text-white transition-colors"
        >
          Delete
        </button>
      )}
    </div>
  );
}

// ── Credential Set Row ─────────────────────────────────────────────

function CredentialSetRow({
  credSet,
  onDeleted,
}: {
  credSet: CredentialSetWithCount;
  onDeleted: () => void;
}) {
  const { client } = useDaemonStore();
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<CredentialEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [showAddEntry, setShowAddEntry] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadEntries = useCallback(async () => {
    if (!client) return;
    setLoadingEntries(true);
    try {
      const data = await client.getCredentialSet(credSet.id);
      setEntries(data.entries);
    } catch {
      // silently fail
    } finally {
      setLoadingEntries(false);
    }
  }, [client, credSet.id]);

  const handleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) loadEntries();
  };

  const handleDelete = async () => {
    if (!client) return;
    await client.deleteCredentialSet(credSet.id);
    onDeleted();
  };

  return (
    <div className="bg-zinc-800 border border-zinc-700 rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-zinc-750"
        onClick={handleExpand}
      >
        <span className="text-xs text-zinc-500">{expanded ? "▼" : "▶"}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-zinc-200">{credSet.name}</div>
          {credSet.description && (
            <div className="text-xs text-zinc-400 mt-0.5">{credSet.description}</div>
          )}
        </div>
        <span className="text-xs text-zinc-500">
          {credSet.entryCount} {credSet.entryCount === 1 ? "entry" : "entries"}
        </span>
        {confirmDelete ? (
          <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={handleDelete}
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

      {expanded && (
        <div className="border-t border-zinc-700 px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-zinc-400">Entries</h4>
            {!showAddEntry && (
              <button
                onClick={() => setShowAddEntry(true)}
                className="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-300 transition-colors"
              >
                + Add Entry
              </button>
            )}
          </div>

          {loadingEntries ? (
            <p className="text-xs text-zinc-500">Loading entries…</p>
          ) : entries.length > 0 ? (
            <div className="space-y-1.5">
              {entries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  setId={credSet.id}
                  onDeleted={loadEntries}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-zinc-500">No entries yet.</p>
          )}

          {showAddEntry && (
            <AddEntryForm
              setId={credSet.id}
              onCreated={() => {
                setShowAddEntry(false);
                loadEntries();
              }}
              onCancel={() => setShowAddEntry(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Audit Log Viewer ───────────────────────────────────────────────

function AuditLogViewer() {
  const { client } = useDaemonStore();
  const [auditLog, setAuditLog] = useState<CredentialAuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const loadAudit = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const data = await client.getCredentialAuditLog();
      setAuditLog(data);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [client]);

  const handleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !auditLog) loadAudit();
  };

  return (
    <div className="mt-6">
      <button
        onClick={handleExpand}
        className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-300 transition-colors"
      >
        <span className="text-xs">{expanded ? "▼" : "▶"}</span>
        Audit Log
        {auditLog && (
          <span className="text-xs text-zinc-500">({auditLog.total} entries)</span>
        )}
      </button>

      {expanded && (
        <div className="mt-2 bg-zinc-800 border border-zinc-700 rounded-lg overflow-hidden">
          {loading ? (
            <p className="text-xs text-zinc-500 p-3">Loading audit log…</p>
          ) : auditLog && auditLog.entries.length > 0 ? (
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-zinc-900 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 text-zinc-400 font-medium">Time</th>
                    <th className="text-left px-3 py-2 text-zinc-400 font-medium">Action</th>
                    <th className="text-left px-3 py-2 text-zinc-400 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLog.entries.map((entry) => (
                    <tr key={entry.id} className="border-t border-zinc-700">
                      <td className="px-3 py-1.5 text-zinc-500 whitespace-nowrap">
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 text-zinc-300">
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded text-xs ${
                            entry.action === "accessed"
                              ? "bg-blue-600/20 text-blue-300"
                              : entry.action === "created"
                                ? "bg-green-600/20 text-green-300"
                                : "bg-red-600/20 text-red-300"
                          }`}
                        >
                          {entry.action}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-zinc-400 font-mono truncate max-w-xs">
                        {entry.details
                          ? JSON.stringify(entry.details)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-zinc-500 p-3">No audit entries.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────

export function Credentials() {
  const { client, connected } = useDaemonStore();
  const [sets, setSets] = useState<CredentialSetWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSets = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const data = await client.listCredentialSets();
      setSets(data.sets as CredentialSetWithCount[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load credential sets");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (connected) loadSets();
  }, [connected, loadSets]);

  if (!connected) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-zinc-200 mb-4">Credentials</h1>
        <p className="text-zinc-500">
          Daemon not connected. Start the daemon to manage credentials.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-zinc-200">Credentials</h1>
        {!showAddForm && (
          <button
            onClick={() => setShowAddForm(true)}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded text-white transition-colors"
          >
            + New Set
          </button>
        )}
      </div>

      {showAddForm && (
        <AddSetForm
          onCreated={() => {
            setShowAddForm(false);
            loadSets();
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
          <p className="text-zinc-500 text-sm">Loading credential sets…</p>
        ) : sets.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-zinc-500 mb-2">No credential sets yet.</p>
            <p className="text-xs text-zinc-600">
              Create a credential set to manage API keys, tokens, and secrets for your sandboxes.
            </p>
          </div>
        ) : (
          sets.map((s) => (
            <CredentialSetRow key={s.id} credSet={s} onDeleted={loadSets} />
          ))
        )}
      </div>

      <AuditLogViewer />
    </div>
  );
}
