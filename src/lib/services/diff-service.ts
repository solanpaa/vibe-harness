export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "delete" | "context";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Parse a unified diff string into structured DiffFile objects.
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const diffSections = diffText.split(/^diff --git /m).filter(Boolean);

  for (const section of diffSections) {
    const lines = section.split("\n");
    const headerLine = lines[0] || "";

    // Parse file paths from "a/path b/path"
    const pathMatch = headerLine.match(/a\/(.+?) b\/(.+)/);
    const oldPath = pathMatch?.[1] || "";
    const newPath = pathMatch?.[2] || oldPath;

    // Determine status
    let status: DiffFile["status"] = "modified";
    if (section.includes("new file mode")) status = "added";
    else if (section.includes("deleted file mode")) status = "deleted";
    else if (oldPath !== newPath) status = "renamed";

    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;

    // Find all hunks
    const hunkRegex = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*)/gm;
    let match;
    const hunkPositions: Array<{
      index: number;
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      header: string;
    }> = [];

    const sectionText = section;
    while ((match = hunkRegex.exec(sectionText)) !== null) {
      hunkPositions.push({
        index: match.index,
        oldStart: parseInt(match[1], 10),
        oldLines: parseInt(match[2] || "1", 10),
        newStart: parseInt(match[3], 10),
        newLines: parseInt(match[4] || "1", 10),
        header: match[0],
      });
    }

    for (let i = 0; i < hunkPositions.length; i++) {
      const hp = hunkPositions[i];
      const startIdx = sectionText.indexOf("\n", hp.index) + 1;
      const endIdx =
        i + 1 < hunkPositions.length
          ? hunkPositions[i + 1].index
          : sectionText.length;
      const hunkBody = sectionText.slice(startIdx, endIdx);

      const diffLines: DiffLine[] = [];
      let oldLine = hp.oldStart;
      let newLine = hp.newStart;

      for (const rawLine of hunkBody.split("\n")) {
        if (rawLine.startsWith("+")) {
          diffLines.push({
            type: "add",
            content: rawLine.slice(1),
            newLineNumber: newLine++,
          });
          additions++;
        } else if (rawLine.startsWith("-")) {
          diffLines.push({
            type: "delete",
            content: rawLine.slice(1),
            oldLineNumber: oldLine++,
          });
          deletions++;
        } else if (rawLine.startsWith(" ")) {
          diffLines.push({
            type: "context",
            content: rawLine.slice(1),
            oldLineNumber: oldLine++,
            newLineNumber: newLine++,
          });
        }
        // Skip \ No newline at end of file and empty lines
      }

      hunks.push({
        oldStart: hp.oldStart,
        oldLines: hp.oldLines,
        newStart: hp.newStart,
        newLines: hp.newLines,
        header: hp.header,
        lines: diffLines,
      });
    }

    files.push({
      path: newPath,
      oldPath: oldPath !== newPath ? oldPath : undefined,
      status,
      additions,
      deletions,
      hunks,
    });
  }

  return files;
}

/**
 * Generate a summary of changes from parsed diff files.
 */
export function diffSummary(files: DiffFile[]): string {
  const totalAdded = files.reduce((s, f) => s + f.additions, 0);
  const totalDeleted = files.reduce((s, f) => s + f.deletions, 0);
  const fileList = files
    .map(
      (f) =>
        `  ${f.status === "added" ? "+" : f.status === "deleted" ? "-" : "~"} ${f.path} (+${f.additions} -${f.deletions})`
    )
    .join("\n");
  return `${files.length} file(s) changed, ${totalAdded} insertions(+), ${totalDeleted} deletions(-)\n\n${fileList}`;
}
