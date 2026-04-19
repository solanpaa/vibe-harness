import { useEffect, useState } from "react";
import { useDaemonStore } from "../../stores/daemon";
import {
  Commit,
  CommitHeader,
  CommitHash,
  CommitMessage,
  CommitMetadata,
  CommitTimestamp,
  CommitCopyButton,
  CommitActions,
  CommitContent,
  CommitFiles,
  CommitFile,
  CommitFilePath,
  CommitFileStatus,
  CommitFileInfo,
} from "@/components/ai-elements/commit";
import type { RunResultResponse } from "@vibe-harness/shared";

function extractFileDiff(fullDiff: string, filePath: string): string | null {
  const fileDiffs = fullDiff.split(/(?=^diff --git )/m);
  const match = fileDiffs.find((d) => d.includes(filePath));
  return match ?? null;
}

function FileDiffView({ diff, filePath }: { diff: string; filePath: string }) {
  const fileDiff = extractFileDiff(diff, filePath);
  if (!fileDiff)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No changes found
      </div>
    );

  return (
    <div className="overflow-x-auto text-xs font-mono leading-relaxed">
      {fileDiff.split("\n").map((line, i) => {
        let className = "px-4 py-0.5 ";
        if (line.startsWith("+") && !line.startsWith("+++")) {
          className += "bg-green-950/30 text-green-300";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          className += "bg-red-950/30 text-red-300";
        } else if (line.startsWith("@@")) {
          className += "bg-blue-950/20 text-blue-400";
        } else {
          className += "text-zinc-400";
        }
        return (
          <div key={i} className={className}>
            {line || "\u00a0"}
          </div>
        );
      })}
    </div>
  );
}

export function ResultPanel({ runId }: { runId: string }) {
  const { client } = useDaemonStore();
  const [result, setResult] = useState<RunResultResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!client) return;
    client
      .getRunResult(runId)
      .then(setResult)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [client, runId]);

  const toggleFile = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

    // Lazy load diff on first expand
    if (!diff && !diffLoading && client) {
      setDiffLoading(true);
      client
        .getRunDiff(runId)
        .then((res) => setDiff(res.diff))
        .catch(() => {})
        .finally(() => setDiffLoading(false));
    }
  };

  if (loading) {
    return (
      <div className="p-4 text-zinc-500 text-sm">Loading result...</div>
    );
  }

  if (!result?.commitHash) {
    return (
      <div className="p-4 text-zinc-500 text-sm">
        No commit data available for this run.
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div className="text-sm text-zinc-400">
        Merged{" "}
        <span className="font-mono text-zinc-200">{result.branch}</span>
        {" → "}
        <span className="font-mono text-zinc-200">{result.targetBranch}</span>
      </div>

      <Commit defaultOpen>
        <CommitHeader>
          <div className="flex flex-col gap-1">
            <CommitMessage>{result.commitMessage}</CommitMessage>
            <CommitMetadata>
              <CommitHash>{result.commitHash.slice(0, 7)}</CommitHash>
              {result.completedAt && (
                <CommitTimestamp date={new Date(result.completedAt)} />
              )}
            </CommitMetadata>
          </div>
          <CommitActions>
            <CommitCopyButton hash={result.commitHash} />
          </CommitActions>
        </CommitHeader>

        {result.filesChanged.length > 0 && (
          <CommitContent>
            <CommitFiles>
              {result.filesChanged.map((file, i) => (
                <div key={i}>
                  <button
                    onClick={() => toggleFile(file.path)}
                    className="w-full text-left"
                  >
                    <CommitFile>
                      <CommitFileInfo>
                        <CommitFileStatus status={file.status as any} />
                        <CommitFilePath>{file.path}</CommitFilePath>
                      </CommitFileInfo>
                    </CommitFile>
                  </button>

                  {expandedFiles.has(file.path) && (
                    <div className="border-x border-b border-border rounded-b-md overflow-hidden">
                      {diffLoading ? (
                        <div className="p-4 text-sm text-muted-foreground">
                          Loading diff...
                        </div>
                      ) : diff ? (
                        <FileDiffView diff={diff} filePath={file.path} />
                      ) : (
                        <div className="p-4 text-sm text-muted-foreground">
                          Diff not available
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </CommitFiles>
            {result.diffStat && (
              <div className="px-4 py-2 text-xs text-zinc-500 font-mono border-t border-zinc-700/30">
                {result.diffStat.split("\n").pop()}
              </div>
            )}
          </CommitContent>
        )}
      </Commit>
    </div>
  );
}
