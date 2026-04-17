import { useEffect, useState, useCallback, useRef } from "react";
import { useDaemonStore } from "../../stores/daemon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ProjectListResponse,
  WorkflowTemplateListResponse,
  AgentDefinitionListResponse,
  CredentialSetListResponse,
  CreateWorkflowRunRequest,
} from "@vibe-harness/shared";

interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl: string; // base64 data URL
  previewUrl?: string;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface NewRunModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (runId: string) => void;
}

export function NewRunModal({ open, onClose, onCreated }: NewRunModalProps) {
  const { client } = useDaemonStore();

  // Form state
  const [projectId, setProjectId] = useState("");
  const [workflowTemplateId, setWorkflowTemplateId] = useState("");
  const [agentDefinitionId, setAgentDefinitionId] = useState("");
  const [description, setDescription] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [credentialSetId, setCredentialSetId] = useState("");
  const [model, setModel] = useState("");
  const [ghAccount, setGhAccount] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Data
  const [projects, setProjects] = useState<ProjectListResponse["projects"]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplateListResponse["templates"]>([]);
  const [agents, setAgents] = useState<AgentDefinitionListResponse["agents"]>([]);
  const [credentials, setCredentials] = useState<CredentialSetListResponse["sets"]>([]);
  const [ghAccounts, setGhAccounts] = useState<Array<{ username: string; hostname: string; isActive: boolean }>>([]);
  const [branches, setBranches] = useState<string[]>([]);

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Fetch initial data
  useEffect(() => {
    if (!open || !client) return;

    Promise.all([
      client.listProjects(),
      client.listWorkflowTemplates(),
      client.listAgents(),
      client.listCredentialSets(),
      client.listGhAccounts(),
    ])
      .then(([projRes, tmplRes, agentRes, credRes, ghRes]) => {
        setProjects(projRes.projects);
        setTemplates(tmplRes.templates);
        setAgents(agentRes.agents);
        setCredentials(credRes.sets);
        setGhAccounts(ghRes.accounts);

        // Auto-select when only one option
        if (projRes.projects.length === 1 && !projectId) {
          setProjectId(projRes.projects[0].id);
        }
        if (tmplRes.templates.length > 0 && !workflowTemplateId) {
          setWorkflowTemplateId(tmplRes.templates[0].id);
        }
        if (agentRes.agents.length > 0 && !agentDefinitionId) {
          setAgentDefinitionId(agentRes.agents[0].id);
        }
      })
      .catch((err) =>
        console.error("Failed to load modal data:", err),
      );
  }, [open, client]);

  // Fetch branches when project changes
  useEffect(() => {
    if (!projectId || !client) {
      setBranches([]);
      return;
    }

    client
      .getProjectBranches(projectId)
      .then((res) => {
        setBranches(res.branches.map((b) => b.name));
        // Auto-set base branch to current
        const current = res.branches.find((b) => b.isCurrent);
        if (current && !baseBranch) {
          setBaseBranch(current.name);
        }
      })
      .catch(() => setBranches([]));
  }, [projectId, client]);

  // Handle file selection
  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const newAttachments: Attachment[] = [];
    for (const file of Array.from(files)) {
      const dataUrl = await readFileAsDataUrl(file);
      newAttachments.push({
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl,
        previewUrl: file.type.startsWith("image/") ? dataUrl : undefined,
      });
    }
    setAttachments((prev) => [...prev, ...newAttachments]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Handle paste (for images)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        handleFiles(files);
      }
    },
    [handleFiles],
  );

  // Handle drag & drop
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles],
  );

  const handleSubmit = useCallback(async () => {
    if (!client || !projectId || !workflowTemplateId || !agentDefinitionId || !description.trim()) {
      setError("Please fill in all required fields");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const req: CreateWorkflowRunRequest = {
        projectId,
        workflowTemplateId,
        agentDefinitionId,
        description: description.trim(),
        ...(baseBranch ? { baseBranch } : {}),
        ...(credentialSetId ? { credentialSetId } : {}),
        ...(model ? { model } : {}),
        ...(ghAccount ? { ghAccount } : {}),
        ...(attachments.length > 0
          ? {
              attachments: attachments.map((a) => ({
                name: a.name,
                type: a.type,
                dataUrl: a.dataUrl,
              })),
            }
          : {}),
      };

      const res = await client.createRun(req);
      onCreated(res.id);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create run");
    } finally {
      setSubmitting(false);
    }
  }, [
    client, projectId, workflowTemplateId, agentDefinitionId,
    description, baseBranch, credentialSetId, model, ghAccount, onCreated,
  ]);

  const resetForm = () => {
    setDescription("");
    setBaseBranch("");
    setModel("");
    setGhAccount("");
    setAttachments([]);
    setExpanded(false);
    setError(null);
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose],
  );

  if (!open) return null;

  // Expanded mode: description takes full screen
  if (expanded) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="flex flex-col bg-card border border-border rounded-xl shadow-2xl"
        style={{ width: 'calc(100vw - 4rem)', height: 'calc(100vh - 4rem)' }}
        onKeyDown={handleKeyDown}
      >
        {/* Compact header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-border/50">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setExpanded(false)}
              className="text-muted-foreground hover:text-foreground text-sm flex items-center gap-1"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M10 3L5 8L10 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Back
            </button>
            <span className="text-sm text-muted-foreground">New Run — Description</span>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg"
          >
            ✕
          </button>
        </div>

        {/* Full description area */}
        <div
          className="flex-1 flex flex-col p-6 min-h-0"
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <textarea
            ref={textareaRef}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onPaste={handlePaste}
            placeholder="Describe what the agent should do...&#10;&#10;Paste images with ⌘V or drag files here."
            className="flex-1 w-full bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none resize-none"
            autoFocus
          />

          {/* Attachments */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-3 border-t border-border/30 mt-3">
              {attachments.map((a) => (
                <AttachmentChip key={a.id} attachment={a} onRemove={removeAttachment} />
              ))}
            </div>
          )}

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between pt-3 mt-auto">
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.json,.csv"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-muted-foreground hover:text-foreground p-1.5 rounded-md hover:bg-accent/50 transition-colors"
                title="Attach files"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <span className="text-xs text-muted-foreground">
                {attachments.length > 0 ? `${attachments.length} file${attachments.length > 1 ? "s" : ""} attached` : "Drag & drop or paste images"}
              </span>
            </div>
            <button
              onClick={handleSubmit}
              disabled={submitting || !projectId || !workflowTemplateId || !agentDefinitionId || !description.trim()}
              className="px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "Creating..." : "Create Run"}
            </button>
          </div>
        </div>
      </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
          <h2 className="text-lg font-semibold text-foreground">New Run</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg"
          >
            ✕
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-4 space-y-4">
          {/* Project (required) */}
          <FormField label="Project" required>
            <Select value={projectId} onValueChange={(v) => setProjectId(v ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select project...">
                  {projects.find(p => p.id === projectId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {/* Workflow template (required) */}
          <FormField label="Workflow Template" required>
            <Select value={workflowTemplateId} onValueChange={(v) => setWorkflowTemplateId(v ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select template...">
                  {templates.find(t => t.id === workflowTemplateId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {/* Agent (required) */}
          <FormField label="Agent" required>
            <Select value={agentDefinitionId} onValueChange={(v) => setAgentDefinitionId(v ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select agent...">
                  {agents.find(a => a.id === agentDefinitionId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {/* Description / prompt (required) */}
          <FormField label="Description" required>
            <div
              className="relative"
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
            >
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onPaste={handlePaste}
                placeholder="Describe what the agent should do..."
                rows={4}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring/50 resize-none pr-16"
              />
              <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.pdf,.txt,.md,.json,.csv"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) handleFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent/50 transition-colors"
                  title="Attach files"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent/50 transition-colors"
                  title="Expand to fullscreen"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </div>
            </div>
            {/* Attachment previews */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {attachments.map((a) => (
                  <AttachmentChip key={a.id} attachment={a} onRemove={removeAttachment} />
                ))}
              </div>
            )}
          </FormField>

          {/* Base branch */}
          <FormField label="Base Branch">
            <Select
              value={baseBranch || "default"}
              onValueChange={(v) => setBaseBranch(v === "default" || !v ? "" : v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Default branch">
                  {baseBranch || "Default branch"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default branch</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {/* Credential set */}
          <FormField label="Credential Set">
            <Select
              value={credentialSetId || "none"}
              onValueChange={(v) => setCredentialSetId(v === "none" || !v ? "" : v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="None">
                  {credentials.find(c => c.id === credentialSetId)?.name || "None"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {credentials.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {/* Model override */}
          <FormField label="Model">
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. gpt-4.1, claude-sonnet-4.5"
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring/50"
            />
          </FormField>

          {/* GitHub Account */}
          {ghAccounts.length > 0 && (
            <FormField label="GitHub Account">
              <select
                value={ghAccount}
                onChange={(e) => setGhAccount(e.target.value)}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring/50"
              >
                <option value="">Default</option>
                {ghAccounts.map((acc) => (
                  <option key={acc.username} value={acc.username}>
                    {acc.username}{acc.isActive ? " (active)" : ""} — {acc.hostname}
                  </option>
                ))}
              </select>
            </FormField>
          )}

          {/* Error */}
          {error && (
            <div className="text-sm text-red-400 bg-red-950/30 border border-red-500/20 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !projectId || !workflowTemplateId || !agentDefinitionId || !description.trim()}
            className="px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? "Creating..." : "Create Run"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FormField({
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
      <label className="block text-xs font-medium text-muted-foreground mb-1.5">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: (id: string) => void;
}) {
  const isImage = attachment.type.startsWith("image/");
  const sizeStr =
    attachment.size < 1024
      ? `${attachment.size}B`
      : attachment.size < 1024 * 1024
        ? `${Math.round(attachment.size / 1024)}KB`
        : `${(attachment.size / (1024 * 1024)).toFixed(1)}MB`;

  return (
    <div className="group relative flex items-center gap-1.5 bg-muted/50 border border-border rounded-md px-2 py-1 text-xs">
      {isImage && attachment.previewUrl ? (
        <img
          src={attachment.previewUrl}
          alt={attachment.name}
          className="w-6 h-6 rounded object-cover"
        />
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-muted-foreground">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )}
      <span className="text-foreground truncate max-w-[120px]">{attachment.name}</span>
      <span className="text-muted-foreground">{sizeStr}</span>
      <button
        onClick={() => onRemove(attachment.id)}
        className="ml-0.5 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        title="Remove"
      >
        ✕
      </button>
    </div>
  );
}
