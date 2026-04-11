import type { DiffFile, DiffFileStatus } from "@vibe-harness/shared";

interface FileTreeProps {
  files: DiffFile[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}

const STATUS_ICONS: Record<DiffFileStatus, { label: string; color: string }> = {
  added:    { label: "A", color: "text-green-400" },
  modified: { label: "M", color: "text-blue-400" },
  deleted:  { label: "D", color: "text-red-400" },
  renamed:  { label: "R", color: "text-yellow-400" },
};

function getFilePath(file: DiffFile): string {
  return file.newPath ?? file.oldPath ?? "unknown";
}

function getFileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function getDirectory(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

export function FileTree({ files, selectedFile, onSelectFile }: FileTreeProps) {
  const totalAdditions = files.reduce((a, f) => a + f.additions, 0);
  const totalDeletions = files.reduce((a, f) => a + f.deletions, 0);

  // Group by directory, sorted: directories alphabetically, files alphabetically
  const grouped = new Map<string, DiffFile[]>();
  for (const file of files) {
    const dir = getDirectory(getFilePath(file));
    const existing = grouped.get(dir) ?? [];
    existing.push(file);
    grouped.set(dir, existing);
  }
  const sortedDirs = [...grouped.keys()].sort();

  return (
    <div className="flex flex-col text-sm">
      {/* Stats header */}
      <div className="px-3 py-2 border-b border-zinc-700/30 text-xs text-zinc-400">
        <span>{files.length} file{files.length !== 1 ? "s" : ""} changed</span>
        {totalAdditions > 0 && (
          <span className="text-green-400 ml-2">+{totalAdditions}</span>
        )}
        {totalDeletions > 0 && (
          <span className="text-red-400 ml-1">-{totalDeletions}</span>
        )}
      </div>

      {/* File list */}
      <div className="overflow-y-auto flex-1">
        {sortedDirs.map((dir) => {
          const dirFiles = grouped.get(dir)!;
          dirFiles.sort((a, b) =>
            getFilePath(a).localeCompare(getFilePath(b))
          );

          return (
            <div key={dir}>
              {dir && (
                <div className="px-3 py-1 text-[10px] text-zinc-500 font-mono truncate">
                  {dir}/
                </div>
              )}
              {dirFiles.map((file) => {
                const path = getFilePath(file);
                const isSelected = selectedFile === path;
                const icon = STATUS_ICONS[file.status];

                return (
                  <button
                    key={path}
                    onClick={() => onSelectFile(path)}
                    className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-zinc-800/50 transition-colors ${
                      isSelected ? "bg-zinc-700/50" : ""
                    }`}
                  >
                    <span className={`font-mono text-xs font-bold w-4 flex-shrink-0 ${icon.color}`}>
                      {icon.label}
                    </span>
                    <span className="text-zinc-300 truncate flex-1 font-mono text-xs">
                      {getFileName(path)}
                    </span>
                    <span className="text-[10px] flex-shrink-0 flex gap-1">
                      {file.additions > 0 && (
                        <span className="text-green-400">+{file.additions}</span>
                      )}
                      {file.deletions > 0 && (
                        <span className="text-red-400">-{file.deletions}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
