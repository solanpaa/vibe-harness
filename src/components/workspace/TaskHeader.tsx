import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Play, Square, TerminalSquare, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import type { EnrichedTask } from "./TaskFeed";
import type { TaskStatusConfig } from "@/lib/status-config";

interface TaskHeaderProps {
  task: EnrichedTask;
  currentStatus: string;
  statusConfig: TaskStatusConfig;
  sandboxId: string | null;
  shellCommand: string | null;
  onStart: () => void;
  onStop: () => void;
  onResume: () => void;
  onDelete: () => void;
}

export function TaskHeader({
  task,
  currentStatus,
  statusConfig,
  sandboxId,
  shellCommand,
  onStart,
  onStop,
  onResume,
  onDelete,
}: TaskHeaderProps) {
  const showShell = sandboxId && currentStatus !== "pending";

  function handleOpenShell() {
    if (!shellCommand) return;
    navigator.clipboard.writeText(shellCommand);
    toast.success("Copied! Paste in your terminal to open a shell in the sandbox.");
  }
  return (
    <div className="shrink-0 bg-card border-b shadow-sm">
      <div className="p-4 pb-3">
        {/* Title row */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight">
              {task.projectName}
            </h2>
            {task.stageName && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Stage: {task.stageName}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {currentStatus === "pending" && (
              <Button size="sm" onClick={onStart}>
                <Play className="mr-1 h-3 w-3" />
                Start
              </Button>
            )}
            {currentStatus === "running" && (
              <Button size="sm" variant="destructive" onClick={onStop}>
                <Square className="mr-1 h-3 w-3" />
                Stop
              </Button>
            )}
            {currentStatus === "paused" && (
              <Button size="sm" onClick={onResume}>
                <Play className="mr-1 h-3 w-3" />
                Resume
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              disabled={currentStatus === "running"}
              title={currentStatus === "running" ? "Stop the task before deleting" : "Delete task"}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Metadata badges */}
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        <Badge className={statusConfig.colorClass}>
          <span className="mr-1">{statusConfig.icon}</span>
          {statusConfig.label}
        </Badge>
        {showShell && (
          <Button size="sm" variant="outline" className="h-5 px-2 text-xs" onClick={handleOpenShell}>
            <TerminalSquare className="mr-1 h-3 w-3" />
            Shell
          </Button>
        )}
        <Badge variant="outline">{task.agentName}</Badge>
        {task.model && (
          <Badge variant="secondary" className="text-xs">
            {task.model}
          </Badge>
        )}
        {task.workflow && (
          <Badge variant="outline" className="gap-1">
            <Workflow className="h-3 w-3" />
            {task.workflow.templateName}
            {task.stageName && (
              <>
                <span className="text-muted-foreground">·</span>
                {task.stageName}
                <span className="text-muted-foreground">
                  (
                  {(task.workflow.stages.findIndex(
                    (s) => s.name === task.stageName,
                  ) ?? 0) + 1}
                  /{task.workflow.stages.length})
                </span>
              </>
            )}
          </Badge>
        )}
        {sandboxId && (
          <Badge variant="outline" className="font-mono text-[10px]">
            {sandboxId}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {new Date(task.createdAt).toLocaleString()}
        </span>
      </div>
    </div>
  );
}
