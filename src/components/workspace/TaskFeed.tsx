"use client";

import { useMemo, useState } from "react";
import { Plus, Search, GitCompare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { TaskFeedItem } from "./TaskFeedItem";
import { ReviewFeedItem } from "./ReviewFeedItem";
import { WorkflowGroup } from "./WorkflowGroup";
import type { Selection } from "@/lib/types";

// ─── Public types ────────────────────────────────────────────────────────────

export interface EnrichedTask {
  id: string;
  projectId: string;
  projectName: string;
  title: string | null;
  agentName: string;
  agentType: string;
  workflowRunId: string | null;
  stageName: string | null;
  originTaskId: string | null;
  status: string;
  prompt: string;
  model: string | null;
  sandboxId: string | null;
  executionMode?: string;
  comparisonGroupId?: string | null;
  createdAt: string;
  completedAt: string | null;
  latestReview: { id: string; round: number; status: string } | null;
  workflow: {
    runId: string;
    runTitle: string | null;
    templateName: string;
    currentStage: string;
    runStatus: string;
    stages: Array<{
      name: string;
      promptTemplate: string;
      reviewRequired: boolean;
    }>;
  } | null;
}

export interface TaskFeedProps {
  tasks: EnrichedTask[];
  selection: Selection | null;
  onSelectTask: (taskId: string) => void;
  onSelectReview: (reviewId: string, taskId: string) => void;
  onNewTask: () => void;
  loading?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function dateLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();

  const strip = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  const diff = strip(now) - strip(date);
  const oneDay = 86_400_000;

  if (diff < oneDay) return "Today";
  if (diff < oneDay * 2) return "Yesterday";

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// A single rendered entry can be either a standalone task, a workflow group, or a comparison group.
type FeedEntry =
  | { kind: "task"; task: EnrichedTask }
  | {
      kind: "workflow";
      runId: string;
      tasks: EnrichedTask[];
      latestCreatedAt: string;
    }
  | {
      kind: "comparison";
      groupId: string;
      tasks: EnrichedTask[];
      latestCreatedAt: string;
    };

interface DateGroup {
  label: string;
  entries: FeedEntry[];
}

function buildGroups(tasks: EnrichedTask[]): DateGroup[] {
  // Sort all tasks newest-first
  const sorted = [...tasks].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  // Group by date label, preserving order
  const dateMap = new Map<string, EnrichedTask[]>();
  for (const task of sorted) {
    const label = dateLabel(task.createdAt);
    let group = dateMap.get(label);
    if (!group) {
      group = [];
      dateMap.set(label, group);
    }
    group.push(task);
  }

  // Within each date group, build entries
  const groups: DateGroup[] = [];

  for (const [label, dateTasks] of dateMap) {
    const workflowBuckets = new Map<string, EnrichedTask[]>();
    const comparisonBuckets = new Map<string, EnrichedTask[]>();
    const standalone: EnrichedTask[] = [];

    for (const task of dateTasks) {
      if (task.workflowRunId) {
        let bucket = workflowBuckets.get(task.workflowRunId);
        if (!bucket) {
          bucket = [];
          workflowBuckets.set(task.workflowRunId, bucket);
        }
        bucket.push(task);
      } else if (task.comparisonGroupId) {
        let bucket = comparisonBuckets.get(task.comparisonGroupId);
        if (!bucket) {
          bucket = [];
          comparisonBuckets.set(task.comparisonGroupId, bucket);
        }
        bucket.push(task);
      } else {
        standalone.push(task);
      }
    }

    // Build entries with a sortable timestamp
    const entries: FeedEntry[] = [];

    for (const task of standalone) {
      entries.push({ kind: "task", task });
    }

    for (const [runId, wfTasks] of workflowBuckets) {
      const latestCreatedAt = wfTasks.reduce((max, t) =>
        t.createdAt > max ? t.createdAt : max,
        wfTasks[0].createdAt,
      );
      entries.push({ kind: "workflow", runId, tasks: wfTasks, latestCreatedAt });
    }

    for (const [groupId, cmpTasks] of comparisonBuckets) {
      const latestCreatedAt = cmpTasks.reduce((max, t) =>
        t.createdAt > max ? t.createdAt : max,
        cmpTasks[0].createdAt,
      );
      entries.push({ kind: "comparison", groupId, tasks: cmpTasks, latestCreatedAt });
    }

    // Sort entries newest-first
    entries.sort((a, b) => {
      const aTime =
        a.kind === "task" ? a.task.createdAt : a.latestCreatedAt;
      const bTime =
        b.kind === "task" ? b.task.createdAt : b.latestCreatedAt;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });

    groups.push({ label, entries });
  }

  return groups;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TaskFeed({
  tasks,
  selection,
  onSelectTask,
  onSelectReview,
  onNewTask,
  loading = false,
}: TaskFeedProps) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return tasks;
    const q = search.toLowerCase();
    return tasks.filter((t) => t.prompt.toLowerCase().includes(q));
  }, [tasks, search]);

  const groups = useMemo(() => buildGroups(filtered), [filtered]);

  const isTaskSelected = (taskId: string) =>
    selection?.kind === "task" && selection.taskId === taskId;

  const isReviewSelected = (reviewId: string) =>
    selection?.kind === "review" && selection.reviewId === reviewId;

  return (
    <div className="flex h-full flex-col">
      {/* Actions */}
      <div className="space-y-2 p-3 pb-0">
        <Button className="w-full" onClick={onNewTask}>
          <Plus className="size-4" />
          New Task
        </Button>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-7"
          />
        </div>
      </div>

      <Separator className="my-2" />

      {/* Feed */}
      <ScrollArea className="flex-1">
        <div className="space-y-3 p-3 pt-0">
          {loading && tasks.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Loading tasks…
            </p>
          )}

          {!loading && groups.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {search ? "No matching tasks" : "No tasks yet"}
            </p>
          )}

          {groups.map((group) => (
            <div key={group.label} className="space-y-px">
              <h3 className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.label}
              </h3>

              {group.entries.map((entry) => {
                if (entry.kind === "task") {
                  return (
                    <div key={entry.task.id}>
                      <TaskFeedItem
                        task={entry.task}
                        isSelected={isTaskSelected(entry.task.id)}
                        onClick={() => onSelectTask(entry.task.id)}
                      />
                      {entry.task.latestReview && (
                        <div className="ml-3 border-l border-border/60 pl-1">
                          <ReviewFeedItem
                            reviewId={entry.task.latestReview.id}
                            round={entry.task.latestReview.round}
                            status={entry.task.latestReview.status}
                            isSelected={isReviewSelected(entry.task.latestReview.id)}
                            isNested
                            onClick={() =>
                              onSelectReview(
                                entry.task.latestReview!.id,
                                entry.task.id,
                              )
                            }
                          />
                        </div>
                      )}
                    </div>
                  );
                }

                if (entry.kind === "workflow") {
                // Workflow group
                const meta = entry.tasks.find((t) => t.workflow)?.workflow;
                return (
                  <WorkflowGroup
                    key={entry.runId}
                    workflowName={meta?.templateName ?? "Workflow"}
                    runTitle={meta?.runTitle}
                    runStatus={meta?.runStatus ?? "pending"}
                    stages={meta?.stages.map((s) => ({ name: s.name })) ?? []}
                    currentStage={meta?.currentStage ?? ""}
                    tasks={entry.tasks}
                    selection={selection}
                    onSelectTask={onSelectTask}
                    onSelectReview={onSelectReview}
                  />
                );
                }

                if (entry.kind === "comparison") {
                const done = entry.tasks.filter(
                  (t) => t.status === "completed" || t.status === "awaiting_review" || t.status === "failed"
                ).length;

                return (
                  <div key={entry.groupId} className="space-y-px">
                    <div className="flex items-center gap-1.5 px-2 py-1">
                      <GitCompare className="size-3.5 text-purple-400" />
                      <span className="text-[12px] font-medium text-purple-400">
                        Compare
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {entry.tasks.length} variants · {done} done
                      </span>
                    </div>
                    <div className="ml-3 border-l border-purple-800/40 pl-1 space-y-px">
                      {entry.tasks.map((task) => (
                        <div key={task.id}>
                          <TaskFeedItem
                            task={{
                              ...task,
                              title: task.title ?? `${task.agentName}${task.model ? ` (${task.model})` : ""}`,
                            }}
                            isSelected={isTaskSelected(task.id)}
                            isNested
                            onClick={() => onSelectTask(task.id)}
                          />
                          {task.latestReview && (
                            <div className="ml-3 border-l border-border/60 pl-1">
                              <ReviewFeedItem
                                reviewId={task.latestReview.id}
                                round={task.latestReview.round}
                                status={task.latestReview.status}
                                isSelected={isReviewSelected(task.latestReview.id)}
                                isNested
                                onClick={() =>
                                  onSelectReview(
                                    task.latestReview!.id,
                                    task.id,
                                  )
                                }
                              />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }

              return null;
              })}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
