import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronRight, RotateCw, FileText, FileDiff, ImageIcon, VideoIcon, FileIcon } from "lucide-react";
import { getGitDiff, getGitFileDiff, getGitFileRawUrl } from "../api";
import type { DiffFileType } from "shared/types/index.js";

// --- Diff parsing types ---

interface DiffLine {
  type: "added" | "removed" | "context" | "hunk-header";
  content: string;
  oldLine?: number;
  newLine?: number;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface DiffFile {
  filename: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  fileType: DiffFileType;
  size: number;
  changeSize: number;
  contentIncluded: boolean;
}

// --- Helpers ---

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Diff parser (single file) ---

function parseSingleFileDiff(raw: string): { hunks: DiffHunk[]; additions: number; deletions: number } {
  if (!raw || !raw.trim()) return { hunks: [], additions: 0, deletions: 0 };

  const lines = raw.split("\n");
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    // Hunk header: @@ -old,count +new,count @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (hunkMatch) {
      currentHunk = { header: line, lines: [] };
      hunks.push(currentHunk);
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      currentHunk.lines.push({ type: "hunk-header", content: line });
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "added", content: line.slice(1), newLine });
      newLine++;
      additions++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "removed", content: line.slice(1), oldLine });
      oldLine++;
      deletions++;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", content: line.slice(1), oldLine, newLine });
      oldLine++;
      newLine++;
    }
    // Skip other lines (e.g., "\ No newline at end of file", index, ---, +++ headers)
  }

  return { hunks, additions, deletions };
}

// --- Component ---

interface GitDiffViewProps {
  folder: string;
}

export default function GitDiffView({ folder }: GitDiffViewProps) {
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());

  const fetchDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { files: fileEntries } = await getGitDiff(folder);

      const parsed: DiffFile[] = fileEntries.map((entry) => {
        const { hunks, additions, deletions } = entry.diff
          ? parseSingleFileDiff(entry.diff)
          : { hunks: [], additions: entry.additions, deletions: entry.deletions };

        return {
          filename: entry.filename,
          status: entry.status,
          fileType: entry.fileType,
          size: entry.size,
          changeSize: entry.changeSize,
          contentIncluded: entry.contentIncluded,
          hunks,
          additions,
          deletions,
        };
      });

      setFiles(parsed);
      // Expand all files by default
      setExpandedFiles(new Set(parsed.map((f) => f.filename)));
    } catch (err: any) {
      setError(err.message || "Failed to fetch diff");
    } finally {
      setLoading(false);
    }
  }, [folder]);

  useEffect(() => {
    fetchDiff();
  }, [fetchDiff]);

  const loadFileContent = useCallback(
    async (filename: string) => {
      setLoadingFiles((prev) => new Set(prev).add(filename));
      try {
        const result = await getGitFileDiff(folder, filename);
        const { hunks, additions, deletions } = parseSingleFileDiff(result.diff);

        setFiles((prev) => prev.map((f) => (f.filename === filename ? { ...f, contentIncluded: true, hunks, additions, deletions } : f)));
      } catch (err: any) {
        console.error("Failed to load file diff:", err);
      } finally {
        setLoadingFiles((prev) => {
          const next = new Set(prev);
          next.delete(filename);
          return next;
        });
      }
    },
    [folder],
  );

  const toggleFile = (filename: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) {
        next.delete(filename);
      } else {
        next.add(filename);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (expandedFiles.size === files.length) {
      setExpandedFiles(new Set());
    } else {
      setExpandedFiles(new Set(files.map((f) => f.filename)));
    }
  };

  if (loading) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-muted)",
        }}
      >
        <RotateCw size={20} style={{ animation: "spin 1s linear infinite", marginRight: 8 }} />
        Loading diff...
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          color: "var(--text-muted)",
        }}
      >
        <div style={{ color: "var(--danger)" }}>{error}</div>
        <button
          onClick={fetchDiff}
          style={{
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            padding: "8px 16px",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          color: "var(--text-muted)",
        }}
      >
        <FileText size={40} strokeWidth={1.5} />
        <div style={{ fontSize: 15, fontWeight: 500 }}>No changes detected</div>
        <div style={{ fontSize: 13 }}>The working directory is clean.</div>
        <button
          onClick={fetchDiff}
          style={{
            background: "var(--bg-secondary, var(--surface))",
            color: "var(--text)",
            border: "1px solid var(--border)",
            padding: "6px 14px",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
            marginTop: 4,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <RotateCw size={14} />
          Refresh
        </button>
      </div>
    );
  }

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "12px 16px" }}>
      {/* Summary bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          padding: "8px 12px",
          background: "var(--bg-secondary, var(--surface))",
          borderRadius: 8,
          border: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <FileDiff size={14} />
            <strong>{files.length}</strong> {files.length === 1 ? "file" : "files"} changed
          </span>
          <span className="diff-stat-added">+{totalAdditions}</span>
          <span className="diff-stat-removed">-{totalDeletions}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={toggleAll}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
              padding: "4px 8px",
            }}
          >
            {expandedFiles.size === files.length ? "Collapse all" : "Expand all"}
          </button>
          <button
            onClick={fetchDiff}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              padding: 4,
            }}
            title="Refresh diff"
          >
            <RotateCw size={14} />
          </button>
        </div>
      </div>

      {/* File list */}
      {files.map((file) => (
        <div
          key={file.filename}
          style={{
            marginBottom: 8,
            border: "1px solid var(--border)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {/* File header */}
          <button onClick={() => toggleFile(file.filename)} className="diff-file-header">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              {expandedFiles.has(file.filename) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span
                style={{
                  fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace",
                  fontSize: 13,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {file.filename}
              </span>
              {file.status === "untracked" && (
                <span
                  style={{
                    fontSize: 10,
                    padding: "1px 6px",
                    borderRadius: 4,
                    background: "rgba(46, 160, 67, 0.2)",
                    color: "#3fb950",
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  NEW
                </span>
              )}
              {file.status === "added" && (
                <span
                  style={{
                    fontSize: 10,
                    padding: "1px 6px",
                    borderRadius: 4,
                    background: "rgba(46, 160, 67, 0.2)",
                    color: "#3fb950",
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  ADDED
                </span>
              )}
              {file.status === "deleted" && (
                <span
                  style={{
                    fontSize: 10,
                    padding: "1px 6px",
                    borderRadius: 4,
                    background: "rgba(248, 81, 73, 0.2)",
                    color: "#f85149",
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  DELETED
                </span>
              )}
              {file.status === "renamed" && (
                <span
                  style={{
                    fontSize: 10,
                    padding: "1px 6px",
                    borderRadius: 4,
                    background: "rgba(124, 106, 239, 0.2)",
                    color: "#7c6aef",
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  RENAMED
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, fontSize: 12 }}>
              {file.additions > 0 && <span className="diff-stat-added">+{file.additions}</span>}
              {file.deletions > 0 && <span className="diff-stat-removed">-{file.deletions}</span>}
            </div>
          </button>

          {/* File content area */}
          {expandedFiles.has(file.filename) && (
            <>
              {/* Case 1: Media file - show preview */}
              {(file.fileType === "image" || file.fileType === "video") && (
                <div
                  style={{
                    padding: 16,
                    textAlign: "center",
                    background: "var(--bg-secondary, var(--surface))",
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                      marginBottom: 8,
                      color: "var(--text-muted)",
                      fontSize: 12,
                    }}
                  >
                    {file.fileType === "image" ? <ImageIcon size={14} /> : <VideoIcon size={14} />}
                    <span>
                      {file.fileType === "image" ? "Image" : "Video"} preview ({formatBytes(file.size)})
                    </span>
                  </div>
                  {file.fileType === "image" ? (
                    <img
                      src={getGitFileRawUrl(folder, file.filename)}
                      alt={file.filename}
                      style={{
                        maxWidth: "100%",
                        maxHeight: 400,
                        borderRadius: 4,
                        border: "1px solid var(--border)",
                      }}
                    />
                  ) : (
                    <video
                      src={getGitFileRawUrl(folder, file.filename)}
                      controls
                      style={{
                        maxWidth: "100%",
                        maxHeight: 400,
                        borderRadius: 4,
                        border: "1px solid var(--border)",
                      }}
                    />
                  )}
                </div>
              )}

              {/* Case 2: Large text file - content not included */}
              {file.fileType === "text" && !file.contentIncluded && (
                <div
                  style={{
                    padding: "16px 20px",
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: 13,
                    background: "var(--bg-secondary, var(--surface))",
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <FileIcon size={16} style={{ marginBottom: 4, opacity: 0.6 }} />
                  <div>
                    <span>Change too large ({formatBytes(file.changeSize)})</span>
                    {" \u2014 "}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        loadFileContent(file.filename);
                      }}
                      disabled={loadingFiles.has(file.filename)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--accent)",
                        cursor: loadingFiles.has(file.filename) ? "wait" : "pointer",
                        textDecoration: "underline",
                        fontSize: 13,
                        padding: 0,
                      }}
                    >
                      {loadingFiles.has(file.filename) ? "Loading..." : "show anyway"}
                    </button>
                  </div>
                </div>
              )}

              {/* Case 3: Normal text diff content */}
              {file.fileType === "text" && file.contentIncluded && (
                <div className="diff-content">
                  {file.hunks.map((hunk, hunkIdx) => (
                    <div key={hunkIdx}>
                      {hunk.lines.map((line, lineIdx) => {
                        if (line.type === "hunk-header") {
                          return (
                            <div key={lineIdx} className="diff-line diff-line-hunk">
                              <span className="diff-line-number" />
                              <span className="diff-line-number" />
                              <span className="diff-line-content">{line.content}</span>
                            </div>
                          );
                        }

                        return (
                          <div
                            key={lineIdx}
                            className={`diff-line ${line.type === "added" ? "diff-line-added" : line.type === "removed" ? "diff-line-removed" : ""}`}
                          >
                            <span className="diff-line-number">{line.type !== "added" ? line.oldLine : ""}</span>
                            <span className="diff-line-number">{line.type !== "removed" ? line.newLine : ""}</span>
                            <span className="diff-line-content">
                              <span className="diff-line-prefix">{line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}</span>
                              {line.content}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}

              {/* Case 4: Binary file */}
              {file.fileType === "binary" && (
                <div
                  style={{
                    padding: "16px 20px",
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: 13,
                    background: "var(--bg-secondary, var(--surface))",
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <FileIcon size={16} style={{ marginBottom: 4, opacity: 0.6 }} />
                  <div>Binary file ({formatBytes(file.size)})</div>
                </div>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
