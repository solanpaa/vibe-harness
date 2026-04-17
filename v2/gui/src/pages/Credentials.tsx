import { useState, useEffect, useCallback, useMemo } from "react";
import { useDaemonStore } from "../stores/daemon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { EyeIcon, EyeOffIcon, FolderOpenIcon } from "lucide-react";
import type {
  CredentialSet,
  CredentialEntry,
  CredentialEntryType,
  CredentialAuditResponse,
} from "@vibe-harness/shared";
import { pickHostFile, pickHostDir, nativePickerAvailable } from "@/lib/file-picker";

// ── Types ──────────────────────────────────────────────────────────────

interface CredentialSetWithCount extends CredentialSet {
  entryCount: number;
}

const ENTRY_TYPES: { value: CredentialEntryType; label: string; description: string }[] = [
  { value: "env_var", label: "Environment Variable", description: "Injected as -e KEY=VALUE" },
  { value: "file_mount", label: "File Mount", description: "Bind-mounts a host file (read-only) into the sandbox" },
  { value: "host_dir_mount", label: "Dir Mount", description: "Bind-mounts a host directory (read-only) into the sandbox" },
  { value: "docker_login", label: "Docker Login", description: "Authenticates against a container registry" },
  { value: "command_extract", label: "Command Extract", description: "⚠️ Runs shell command on HOST and uses its stdout as an env var value" },
];

const inputClass =
  "w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary";
const monoInputClass = `${inputClass} font-mono`;

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
      className="bg-card border border-border rounded-lg p-4 mb-4 space-y-3"
    >
      <h3 className="text-sm font-semibold text-foreground">New Credential Set</h3>
      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Name <span className="text-destructive">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Production API Keys"
          className={inputClass}
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
          className={inputClass}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          {submitting ? "Creating…" : "Create Set"}
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

// ── Path picker input ──────────────────────────────────────────────

function PathInput({
  value,
  onChange,
  kind,
  placeholder,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  kind: "file" | "dir";
  placeholder?: string;
  required?: boolean;
}) {
  const canPick = nativePickerAvailable();
  const [pickerError, setPickerError] = useState<string | null>(null);

  const handlePick = async () => {
    setPickerError(null);
    try {
      const picked = kind === "file" ? await pickHostFile() : await pickHostDir();
      if (picked) onChange(picked);
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : "Picker unavailable");
    }
  };

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={monoInputClass}
          required={required}
        />
        {canPick && (
          <button
            type="button"
            onClick={handlePick}
            className="px-2 py-1.5 text-xs bg-muted hover:bg-accent rounded-md text-muted-foreground transition-colors flex items-center gap-1 shrink-0"
            aria-label={kind === "file" ? "Browse for file" : "Browse for directory"}
            title={kind === "file" ? "Browse for file" : "Browse for directory"}
          >
            <FolderOpenIcon size={14} />
            Browse
          </button>
        )}
      </div>
      {pickerError && <p className="text-xs text-destructive mt-1">{pickerError}</p>}
    </div>
  );
}

// ── Add Entry Form (dispatches per-type sub-form) ──────────────────

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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Per-type fields. Keep all in this scope so switching type preserves entered data.
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [hostPath, setHostPath] = useState("");
  const [containerPath, setContainerPath] = useState("");
  const [registry, setRegistry] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [command, setCommand] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) return;
    setError(null);
    setSubmitting(true);
    try {
      let payload: {
        key: string;
        value?: string;
        type: CredentialEntryType;
        mountPath?: string;
        command?: string;
      };

      switch (type) {
        case "env_var":
          payload = { key: key.trim(), value, type };
          break;
        case "file_mount":
          payload = {
            key: key.trim(),
            value: hostPath.trim(),
            type,
            mountPath: containerPath.trim(),
          };
          break;
        case "host_dir_mount":
          payload = {
            key: key.trim(),
            value: hostPath.trim(),
            type,
            mountPath: containerPath.trim(),
          };
          break;
        case "docker_login":
          payload = {
            key: registry.trim(),
            value: JSON.stringify({ username, password }),
            type,
          };
          break;
        case "command_extract":
          payload = { key: key.trim(), type, command: command.trim() };
          break;
      }

      await client.addCredentialEntry(setId, payload);
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
      className="bg-card border border-border rounded p-3 mt-3 space-y-3"
    >
      <h4 className="text-xs font-semibold text-foreground">Add Credential Entry</h4>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">Type</label>
        <Select
          value={type}
          onValueChange={(v) => setType(v as CredentialEntryType)}
        >
          <SelectTrigger className="w-full">
            <SelectValue>
              {ENTRY_TYPES.find((t) => t.value === type)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {ENTRY_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          {ENTRY_TYPES.find((t) => t.value === type)?.description}
        </p>
      </div>

      {type === "env_var" && (
        <>
          <Field label="Key" required>
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="API_KEY"
              className={inputClass}
              required
            />
          </Field>
          <Field label="Value" required>
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="secret value"
              rows={2}
              className={monoInputClass}
              required
            />
          </Field>
        </>
      )}

      {type === "file_mount" && (
        <>
          <Field label="Key" required>
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="ssh_key"
              className={inputClass}
              required
            />
          </Field>
          <Field label="Host file path" required>
            <PathInput
              kind="file"
              value={hostPath}
              onChange={setHostPath}
              placeholder="/home/user/.ssh/id_rsa"
              required
            />
          </Field>
          <Field label="Container mount path" required>
            <input
              type="text"
              value={containerPath}
              onChange={(e) => setContainerPath(e.target.value)}
              placeholder="/root/.ssh/id_rsa"
              className={monoInputClass}
              required
            />
          </Field>
        </>
      )}

      {type === "host_dir_mount" && (
        <>
          <Field label="Key" required>
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="config_dir"
              className={inputClass}
              required
            />
          </Field>
          <Field label="Host directory path" required>
            <PathInput
              kind="dir"
              value={hostPath}
              onChange={setHostPath}
              placeholder="/home/user/.config/myapp"
              required
            />
          </Field>
          <Field label="Container mount path" required>
            <input
              type="text"
              value={containerPath}
              onChange={(e) => setContainerPath(e.target.value)}
              placeholder="/root/.config/myapp"
              className={monoInputClass}
              required
            />
          </Field>
        </>
      )}

      {type === "docker_login" && (
        <>
          <Field label="Registry" required>
            <input
              type="text"
              value={registry}
              onChange={(e) => setRegistry(e.target.value)}
              placeholder="registry.example.com"
              className={monoInputClass}
              required
            />
          </Field>
          <Field label="Username" required>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="my-user"
              className={inputClass}
              required
            />
          </Field>
          <Field label="Password" required>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className={inputClass}
              required
            />
          </Field>
        </>
      )}

      {type === "command_extract" && (
        <>
          <Field label="Key" required>
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="GCLOUD_TOKEN"
              className={inputClass}
              required
            />
          </Field>
          <Field label="Command" required>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="gcloud auth print-access-token"
              className={monoInputClass}
              required
            />
          </Field>
          <p className="text-xs text-amber-400">
            ⚠️ This command runs on your HOST machine, not in the sandbox.
          </p>
        </>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          {submitting ? "Adding…" : "Add Entry"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs bg-muted hover:bg-accent rounded-md text-muted-foreground transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs text-muted-foreground mb-1">
        {label} {required && <span className="text-destructive">*</span>}
      </label>
      {children}
    </div>
  );
}

// ── Entry Delete Button ────────────────────────────────────────────

function EntryDeleteButton({
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

  if (confirmDelete) {
    return (
      <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={async () => {
            if (client) {
              await client.deleteCredentialEntry(setId, entry.id);
              onDeleted();
            }
          }}
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
    );
  }

  return (
    <button
      onClick={() => setConfirmDelete(true)}
      className="text-xs text-muted-foreground hover:text-destructive transition-colors"
    >
      Delete
    </button>
  );
}

// ── Entry Row (displays one credential entry; supports reveal) ────

function EntryRow({
  entry,
  setId,
  showValues,
  onDeleted,
}: {
  entry: CredentialEntry;
  setId: string;
  showValues: boolean;
  onDeleted: () => void;
}) {
  const { client } = useDaemonStore();
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  // Fetch on demand when toggle flips on; clear when toggle flips off.
  useEffect(() => {
    if (!showValues) {
      setRevealedValue(null);
      setRevealError(null);
      return;
    }
    if (revealedValue !== null || !client) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await client.revealCredentialEntry(setId, entry.id);
        if (!cancelled) setRevealedValue(res.value);
      } catch (err) {
        if (!cancelled) {
          setRevealError(err instanceof Error ? err.message : "Failed to reveal");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showValues, client, setId, entry.id, revealedValue]);

  const typeLabel = ENTRY_TYPES.find((t) => t.value === entry.type)?.label ?? entry.type;
  const typeColor =
    entry.type === "command_extract"
      ? "text-amber-400"
      : entry.type === "docker_login"
        ? "text-purple-400"
        : entry.type === "file_mount" || entry.type === "host_dir_mount"
          ? "text-emerald-400"
          : "text-blue-400";

  // Secondary info per type
  const secondary = useMemo(() => {
    if (entry.type === "file_mount" || entry.type === "host_dir_mount") {
      // For mounts: showValues controls whether host path (the "value") is visible
      const hostDisplay =
        showValues
          ? (revealError ? `<error: ${revealError}>` : (revealedValue ?? "loading…"))
          : "•".repeat(12);
      return (
        <span className="text-xs text-muted-foreground font-mono truncate">
          <span className={showValues ? "" : "select-none"}>{hostDisplay}</span>
          <span className="mx-1">→</span>
          {entry.mountPath}
        </span>
      );
    }
    if (entry.type === "docker_login") {
      // Username is visible; password never shown via secondary
      return (
        <span className="text-xs text-muted-foreground font-mono truncate">
          {entry.key}
        </span>
      );
    }
    if (entry.type === "command_extract" && entry.command) {
      return (
        <span className="text-xs text-muted-foreground font-mono truncate">
          $ {entry.command}
        </span>
      );
    }
    return null;
  }, [entry, showValues, revealedValue, revealError]);

  // Tertiary: revealed value, only for env_var and docker_login (password)
  const valueDisplay = useMemo(() => {
    if (entry.type === "file_mount" || entry.type === "host_dir_mount") {
      // Value (host path) is shown in secondary; suppress here.
      return null;
    }
    if (entry.type === "command_extract") {
      return null;
    }
    if (!showValues) {
      return <span className="font-mono text-xs text-muted-foreground select-none">{"•".repeat(12)}</span>;
    }
    if (revealError) {
      return <span className="text-xs text-destructive">err</span>;
    }
    if (revealedValue === null) {
      return <span className="text-xs text-muted-foreground">…</span>;
    }
    if (entry.type === "docker_login") {
      // value is JSON({username, password}); show username:••••
      try {
        const parsed = JSON.parse(revealedValue) as { username?: string; password?: string };
        const masked = parsed.password ? "•".repeat(Math.min(parsed.password.length, 12)) : "";
        return (
          <span className="font-mono text-xs text-muted-foreground truncate">
            {parsed.username ?? ""}:{masked || "(no password)"}
          </span>
        );
      } catch {
        return <span className="font-mono text-xs text-muted-foreground">{revealedValue}</span>;
      }
    }
    return (
      <span className="font-mono text-xs text-muted-foreground truncate">
        {revealedValue}
      </span>
    );
  }, [entry.type, showValues, revealedValue, revealError]);

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 border-t border-border first:border-t-0">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className={`text-[11px] font-mono shrink-0 ${typeColor}`}>{typeLabel}</span>
        <span className="font-mono text-sm text-foreground shrink-0">{entry.key}</span>
        {secondary}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {valueDisplay}
        <EntryDeleteButton entry={entry} setId={setId} onDeleted={onDeleted} />
      </div>
    </div>
  );
}

// ── Credential Set Row ─────────────────────────────────────────────

function CredentialSetRow({
  credSet,
  onChanged,
}: {
  credSet: CredentialSetWithCount;
  /** Called whenever the row mutates entries OR is deleted, so the parent can refresh sets (entry counts). */
  onChanged: () => void;
}) {
  const { client } = useDaemonStore();
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<CredentialEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [showAddEntry, setShowAddEntry] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showValues, setShowValues] = useState(false);

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
    onChanged();
  };

  const handleEntryMutation = useCallback(() => {
    loadEntries();
    onChanged();
  }, [loadEntries, onChanged]);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden hover:bg-accent/50 transition-colors">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer"
        onClick={handleExpand}
      >
        <span className="text-xs text-muted-foreground">{expanded ? "▼" : "▶"}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">{credSet.name}</div>
          {credSet.description && (
            <div className="text-xs text-muted-foreground mt-0.5">{credSet.description}</div>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {credSet.entryCount} {credSet.entryCount === 1 ? "entry" : "entries"}
        </span>
        {confirmDelete ? (
          <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={handleDelete}
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

      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center justify-between mb-2 gap-2">
            <h4 className="text-xs font-semibold text-muted-foreground">Entries</h4>
            <div className="flex items-center gap-3">
              {entries.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    {showValues ? <EyeIcon size={14} /> : <EyeOffIcon size={14} />}
                  </span>
                  <Switch
                    aria-label="Toggle value visibility"
                    checked={showValues}
                    onCheckedChange={setShowValues}
                  />
                </div>
              )}
              {!showAddEntry && (
                <button
                  onClick={() => setShowAddEntry(true)}
                  className="px-2 py-1 text-xs bg-muted hover:bg-accent rounded-md text-muted-foreground transition-colors"
                >
                  + Add Entry
                </button>
              )}
            </div>
          </div>

          {loadingEntries ? (
            <p className="text-xs text-muted-foreground">Loading entries…</p>
          ) : entries.length > 0 ? (
            <div className="rounded-lg border border-border bg-background">
              {entries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  setId={credSet.id}
                  showValues={showValues}
                  onDeleted={handleEntryMutation}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No entries yet.</p>
          )}

          {showAddEntry && (
            <AddEntryForm
              setId={credSet.id}
              onCreated={() => {
                setShowAddEntry(false);
                handleEntryMutation();
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
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="text-xs">{expanded ? "▼" : "▶"}</span>
        Audit Log
        {auditLog && (
          <span className="text-xs text-muted-foreground">({auditLog.total} entries)</span>
        )}
      </button>

      {expanded && (
        <div className="mt-2 rounded-lg border border-border bg-card overflow-hidden">
          {loading ? (
            <p className="text-xs text-muted-foreground p-3">Loading audit log…</p>
          ) : auditLog && auditLog.entries.length > 0 ? (
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 text-muted-foreground font-medium">Time</th>
                    <th className="text-left px-3 py-2 text-muted-foreground font-medium">Action</th>
                    <th className="text-left px-3 py-2 text-muted-foreground font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLog.entries.map((entry) => (
                    <tr key={entry.id} className="border-t border-border">
                      <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          {entry.action}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground font-mono truncate max-w-xs">
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
            <p className="text-xs text-muted-foreground p-3">No audit entries.</p>
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
      <div className="p-6 max-w-4xl h-full overflow-y-auto">
        <h1 className="text-sm font-medium text-foreground mb-4">Credentials</h1>
        <p className="text-muted-foreground">
          Daemon not connected. Start the daemon to manage credentials.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl h-full flex flex-col">
      <h1 className="text-sm font-medium text-foreground mb-6">Credentials</h1>

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
        <div className="mb-3 px-3 py-2 bg-destructive/10 border border-destructive/30 rounded text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-2">
        {loading ? (
          <p className="text-muted-foreground text-sm">Loading credential sets…</p>
        ) : sets.length === 0 && !showAddForm ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground mb-3">No credential sets yet.</p>
            <button
              onClick={() => setShowAddForm(true)}
              className="text-sm text-primary hover:text-primary/80 transition-colors"
            >
              Create one to store API keys and tokens →
            </button>
          </div>
        ) : (
          <>
            {sets.map((s) => (
              <CredentialSetRow key={s.id} credSet={s} onChanged={loadSets} />
            ))}
            {!showAddForm && (
              <button
                onClick={() => setShowAddForm(true)}
                className="w-full p-4 rounded-lg border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors text-sm flex items-center justify-center gap-2"
              >
                <span>+</span> Create credential set
              </button>
            )}
          </>
        )}
      </div>

      <AuditLogViewer />
    </div>
  );
}
