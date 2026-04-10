"use client";

import { Badge } from "@/components/ui/badge";
import type { DiffFile } from "@/lib/services/diff-service";
import { FilePlus, FileEdit, FileMinus, FileSymlink } from "lucide-react";

interface FileTreeProps {
  files: DiffFile[];
  selectedFile?: string;
  onSelectFile?: (path: string) => void;
}

export function FileTree({ files, selectedFile, onSelectFile }: FileTreeProps) {
  const statusIcon = {
    added: <FilePlus className="h-3 w-3 text-green-600" />,
    modified: <FileEdit className="h-3 w-3 text-yellow-600" />,
    deleted: <FileMinus className="h-3 w-3 text-red-600" />,
    renamed: <FileSymlink className="h-3 w-3 text-blue-600" />,
  };

  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium mb-2">Files changed ({files.length})</h3>
      {files.map((file) => (
        <button
          key={file.path}
          className={`flex items-center gap-2 w-full px-2 py-1 rounded text-xs font-mono text-left hover:bg-muted ${
            selectedFile === file.path ? "bg-muted" : ""
          }`}
          onClick={() => onSelectFile?.(file.path)}
        >
          {statusIcon[file.status]}
          <span className="flex-1 truncate">{file.path}</span>
          <Badge variant="outline" className="text-[10px] px-1">
            +{file.additions} -{file.deletions}
          </Badge>
        </button>
      ))}
    </div>
  );
}
