import { useEffect, useState } from "react";
import { useDaemonStore } from "../../stores/daemon";
import type { WorkflowStage } from "@vibe-harness/shared";

interface SplitModalProps {
  sourceStageName: string;
  onSubmit: (extraDescription: string) => void;
  onCancel: () => void;
  submitting?: boolean;
}

export function SplitModal({
  sourceStageName,
  onSubmit,
  onCancel,
  submitting,
}: SplitModalProps) {
  const { client } = useDaemonStore();
  const [extraDescription, setExtraDescription] = useState("");
  const [splitterPromptTemplate, setSplitterPromptTemplate] = useState<string>("");
  const [postSplitStages, setPostSplitStages] = useState<WorkflowStage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!client) return;
      try {
        const resp = await client.getSettings();
        if (cancelled) return;
        const settings = resp.settings ?? {};
        const tmpl = settings["defaultSplitterPromptTemplate"];
        const post = settings["defaultPostSplitStages"];
        if (typeof tmpl === "string") setSplitterPromptTemplate(tmpl);
        if (typeof post === "string") {
          try {
            const parsed = JSON.parse(post);
            if (Array.isArray(parsed)) setPostSplitStages(parsed);
          } catch {
            /* ignore */
          }
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load settings");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-shrink-0 px-5 py-3 border-b border-zinc-700/50">
          <h2 className="text-base font-medium text-zinc-100">
            Split stage: <span className="text-purple-300">{sourceStageName}</span>
          </h2>
          <p className="text-xs text-zinc-400 mt-1">
            Send this stage's output to a splitter agent. It will propose sub-tasks
            that run in parallel, then consolidate and continue with the global
            post-split stages.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-sm">
          {loading && <div className="text-zinc-400">Loading settings...</div>}
          {loadError && <div className="text-red-400">Error: {loadError}</div>}

          {!loading && !loadError && (
            <>
              <section>
                <label className="block text-xs text-zinc-400 mb-1">
                  Splitter prompt template (from Settings — read-only)
                </label>
                <pre className="bg-zinc-950/70 border border-zinc-800 rounded p-2 text-xs text-zinc-300 whitespace-pre-wrap max-h-40 overflow-y-auto">
                  {splitterPromptTemplate || "(empty — configure in Settings)"}
                </pre>
              </section>

              <section>
                <label className="block text-xs text-zinc-400 mb-1">
                  Extra description (appended to the splitter prompt)
                </label>
                <textarea
                  value={extraDescription}
                  onChange={(e) => setExtraDescription(e.target.value)}
                  rows={5}
                  placeholder="Provide any extra guidance for the splitter..."
                  className="w-full bg-zinc-950 border border-zinc-700 rounded p-2 text-sm text-zinc-100 focus:outline-none focus:border-purple-500/50"
                />
              </section>

              <section>
                <div className="text-xs text-zinc-400 mb-1">
                  Post-split stages that will run after consolidation (
                  {postSplitStages.length})
                </div>
                {postSplitStages.length === 0 ? (
                  <div className="text-xs text-zinc-500 italic">
                    None configured — workflow will finalize immediately after
                    consolidation review.
                  </div>
                ) : (
                  <ul className="text-xs text-zinc-300 list-disc pl-5 space-y-0.5">
                    {postSplitStages.map((s, i) => (
                      <li key={i}>
                        <span className="text-zinc-100">{s.name}</span>
                        {s.reviewRequired ? (
                          <span className="text-zinc-500"> — review</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="text-xs text-amber-400/80 bg-amber-950/20 border border-amber-900/40 rounded p-2">
                <strong>Note:</strong> remaining stages in this workflow's
                original template will be skipped. Only the post-split stages
                above will run after consolidation.
              </section>
            </>
          )}
        </div>

        <div className="flex-shrink-0 px-5 py-3 border-t border-zinc-700/50 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="px-3 py-1.5 text-xs rounded-md border border-zinc-600 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(extraDescription)}
            disabled={submitting || loading || !!loadError}
            className="px-3 py-1.5 text-xs rounded-md bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-40"
          >
            {submitting ? "Splitting..." : "Split"}
          </button>
        </div>
      </div>
    </div>
  );
}
