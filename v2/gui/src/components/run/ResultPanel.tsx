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

export function ResultPanel({ runId }: { runId: string }) {
  const { client } = useDaemonStore();
  const [result, setResult] = useState<RunResultResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!client) return;
    client
      .getRunResult(runId)
      .then(setResult)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [client, runId]);

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
                <CommitFile key={i}>
                  <CommitFileInfo>
                    <CommitFileStatus status={file.status as any} />
                    <CommitFilePath>{file.path}</CommitFilePath>
                  </CommitFileInfo>
                </CommitFile>
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
