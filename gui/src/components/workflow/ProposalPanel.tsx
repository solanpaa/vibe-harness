import { useEffect, useState, useCallback, useMemo } from "react";
import { useDaemonStore } from "../../stores/daemon";
import { StatusBadge } from "../shared/StatusBadge";
import type {
  Proposal,
  CreateProposalRequest,
  UpdateProposalRequest,
} from "@vibe-harness/shared";

interface ProposalPanelProps {
  runId: string;
  currentStage: string | null;
  onLaunched: () => void;
}

interface EditState {
  title: string;
  description: string;
  affectedFiles: string;
}

export function ProposalPanel({ runId, currentStage, onLaunched }: ProposalPanelProps) {
  const { client } = useDaemonStore();

  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>({ title: "", description: "", affectedFiles: "" });
  const [launching, setLaunching] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addState, setAddState] = useState<EditState>({ title: "", description: "", affectedFiles: "" });
  const [actionError, setActionError] = useState<string | null>(null);

  // Fetch proposals
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getProposals(runId)
      .then((res) => {
        if (cancelled) return;
        setProposals(res.proposals);
        // Auto-select all non-discarded proposals
        const ids = new Set(
          res.proposals
            .filter((p) => p.status !== "discarded")
            .map((p) => p.id),
        );
        setSelected(ids);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load proposals");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [client, runId]);

  const sortedProposals = useMemo(
    () => [...proposals].sort((a, b) => a.sortOrder - b.sortOrder),
    [proposals],
  );

  const activeProposals = useMemo(
    () => sortedProposals.filter((p) => p.status !== "discarded"),
    [sortedProposals],
  );

  const selectedCount = useMemo(
    () => activeProposals.filter((p) => selected.has(p.id)).length,
    [activeProposals, selected],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (selectedCount === activeProposals.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(activeProposals.map((p) => p.id)));
    }
  }, [selectedCount, activeProposals]);

  // Start editing
  const startEdit = useCallback((p: Proposal) => {
    setEditingId(p.id);
    setEditState({
      title: p.title,
      description: p.description,
      affectedFiles: p.affectedFiles?.join(", ") ?? "",
    });
  }, []);

  // Save edit
  const saveEdit = useCallback(async () => {
    if (!client || !editingId) return;
    setActionError(null);
    try {
      const data: UpdateProposalRequest = {
        title: editState.title,
        description: editState.description,
        affectedFiles: editState.affectedFiles
          ? editState.affectedFiles.split(",").map((f) => f.trim()).filter(Boolean)
          : [],
      };
      const res = await client.updateProposal(editingId, data);
      setProposals((prev) =>
        prev.map((p) => (p.id === editingId ? res.proposal : p)),
      );
      setEditingId(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save");
    }
  }, [client, editingId, editState]);

  // Delete (discard) proposal
  const handleDiscard = useCallback(
    async (id: string) => {
      if (!client) return;
      setActionError(null);
      try {
        await client.deleteProposal(id);
        setProposals((prev) => prev.filter((p) => p.id !== id));
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to discard");
      }
    },
    [client],
  );

  // Add new proposal
  const handleAdd = useCallback(async () => {
    if (!client || !addState.title.trim()) return;
    setActionError(null);
    try {
      const data: CreateProposalRequest = {
        workflowRunId: runId,
        stageName: currentStage ?? "split",
        title: addState.title.trim(),
        description: addState.description.trim(),
        affectedFiles: addState.affectedFiles
          ? addState.affectedFiles.split(",").map((f) => f.trim()).filter(Boolean)
          : [],
        sortOrder: proposals.length,
      };
      const res = await client.createProposal(data);
      setProposals((prev) => [...prev, res.proposal]);
      setSelected((prev) => new Set(prev).add(res.proposal.id));
      setAddState({ title: "", description: "", affectedFiles: "" });
      setShowAddForm(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to add proposal");
    }
  }, [client, runId, currentStage, addState, proposals.length]);

  // Launch selected proposals
  const handleLaunch = useCallback(async () => {
    if (!client || launching || selectedCount === 0) return;
    setLaunching(true);
    setActionError(null);
    try {
      const ids = activeProposals
        .filter((p) => selected.has(p.id))
        .map((p) => p.id);
      await client.launchProposals(runId, ids);
      onLaunched();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to launch");
    } finally {
      setLaunching(false);
    }
  }, [client, launching, selectedCount, activeProposals, selected, runId, onLaunched]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Loading proposals...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400 text-sm">
        Error: {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-zinc-700/30">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-zinc-200">
            Review Proposals
          </h3>
          <span className="text-xs text-zinc-500">
            {activeProposals.length} proposal{activeProposals.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleAll}
            className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            {selectedCount === activeProposals.length ? "Deselect All" : "Select All"}
          </button>
        </div>
      </div>

      {/* Action error banner */}
      {actionError && (
        <div className="flex-shrink-0 px-4 py-2 text-sm bg-red-950/30 text-red-300 border-b border-red-500/20">
          {actionError}
          <button
            onClick={() => setActionError(null)}
            className="ml-2 text-red-400 hover:text-red-200"
          >
            ✕
          </button>
        </div>
      )}

      {/* Proposal list */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {activeProposals.map((proposal) => (
          <div
            key={proposal.id}
            className={`rounded-lg border transition-colors ${
              selected.has(proposal.id)
                ? "border-purple-500/40 bg-purple-950/20"
                : "border-zinc-700/30 bg-zinc-800/20"
            }`}
          >
            {editingId === proposal.id ? (
              /* Inline edit mode */
              <div className="p-3 space-y-2">
                <input
                  type="text"
                  value={editState.title}
                  onChange={(e) => setEditState((s) => ({ ...s, title: e.target.value }))}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-purple-500"
                  placeholder="Proposal title"
                />
                <textarea
                  value={editState.description}
                  onChange={(e) => setEditState((s) => ({ ...s, description: e.target.value }))}
                  rows={3}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-300 focus:outline-none focus:border-purple-500 resize-y"
                  placeholder="Description"
                />
                <input
                  type="text"
                  value={editState.affectedFiles}
                  onChange={(e) => setEditState((s) => ({ ...s, affectedFiles: e.target.value }))}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-400 focus:outline-none focus:border-purple-500"
                  placeholder="Affected files (comma-separated)"
                />
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={saveEdit}
                    className="px-2.5 py-1 text-xs rounded-md bg-purple-600 text-white hover:bg-purple-500 transition-colors"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="px-2.5 py-1 text-xs rounded-md text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              /* Display mode */
              <div className="p-3">
                <div className="flex items-start gap-3">
                  {/* Checkbox */}
                  <button
                    onClick={() => toggleSelect(proposal.id)}
                    className="mt-0.5 flex-shrink-0"
                  >
                    <span
                      className={`inline-flex items-center justify-center w-4 h-4 rounded border text-[10px] ${
                        selected.has(proposal.id)
                          ? "bg-purple-600 border-purple-500 text-white"
                          : "border-zinc-600 text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                  </button>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-200 truncate">
                        {proposal.title}
                      </span>
                      <StatusBadge status={proposal.status} size="sm" />
                      <span className="text-[10px] text-zinc-600">
                        #{proposal.sortOrder + 1}
                      </span>
                    </div>
                    {proposal.description && (
                      <p className="text-xs text-zinc-400 mt-1 line-clamp-2">
                        {proposal.description}
                      </p>
                    )}
                    {proposal.affectedFiles && proposal.affectedFiles.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {proposal.affectedFiles.map((file) => (
                          <span
                            key={file}
                            className="inline-block text-[10px] font-mono text-zinc-500 bg-zinc-800 rounded px-1.5 py-0.5"
                          >
                            {file}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => startEdit(proposal)}
                      className="p-1 text-zinc-500 hover:text-zinc-200 transition-colors"
                      title="Edit"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => handleDiscard(proposal.id)}
                      className="p-1 text-zinc-500 hover:text-red-400 transition-colors"
                      title="Discard"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {activeProposals.length === 0 && (
          <div className="text-center text-zinc-500 text-sm py-8">
            No proposals yet. Add one below or wait for the agent to generate them.
          </div>
        )}
      </div>

      {/* Add proposal form */}
      {showAddForm && (
        <div className="flex-shrink-0 px-4 py-3 border-t border-zinc-700/30 space-y-2">
          <input
            type="text"
            value={addState.title}
            onChange={(e) => setAddState((s) => ({ ...s, title: e.target.value }))}
            className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-purple-500"
            placeholder="Proposal title"
            autoFocus
          />
          <textarea
            value={addState.description}
            onChange={(e) => setAddState((s) => ({ ...s, description: e.target.value }))}
            rows={2}
            className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-300 focus:outline-none focus:border-purple-500 resize-y"
            placeholder="Description"
          />
          <input
            type="text"
            value={addState.affectedFiles}
            onChange={(e) => setAddState((s) => ({ ...s, affectedFiles: e.target.value }))}
            className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-400 focus:outline-none focus:border-purple-500"
            placeholder="Affected files (comma-separated)"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleAdd}
              disabled={!addState.title.trim()}
              className="px-2.5 py-1 text-xs rounded-md bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-40 transition-colors"
            >
              Add
            </button>
            <button
              onClick={() => { setShowAddForm(false); setAddState({ title: "", description: "", affectedFiles: "" }); }}
              className="px-2.5 py-1 text-xs rounded-md text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Bottom toolbar */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-t border-zinc-700/30 bg-zinc-900/50">
        <button
          onClick={() => setShowAddForm(true)}
          disabled={showAddForm}
          className="px-3 py-1.5 text-xs rounded-md border border-zinc-600 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 disabled:opacity-40 transition-colors"
        >
          + Add Proposal
        </button>
        <button
          onClick={handleLaunch}
          disabled={launching || selectedCount === 0}
          className="px-4 py-1.5 text-xs font-medium rounded-md bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-40 transition-colors"
        >
          {launching
            ? "Launching..."
            : `Launch Selected (${selectedCount})`}
        </button>
      </div>
    </div>
  );
}
