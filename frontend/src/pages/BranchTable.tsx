import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, GitBranch, ExternalLink, ChevronUp, ChevronDown, ChevronsUpDown, Check, X, Clock, CircleDashed, AlertCircle, MessageSquareWarning } from "lucide-react";
import { listFolders, getBranchOverview, type BranchOverviewFolder, type BranchRow, type FolderSummary, type PrInfo } from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import { formatRelativeTime } from "../utils/dateFormat";

type SortKey =
  | "branch"
  | "folder"
  | "worktree"
  | "ahead"
  | "behind"
  | "lastCommit"
  | "pr"
  | "prState"
  | "approved"
  | "comments"
  | "checks";

type SortDir = "asc" | "desc";

interface FlatRow extends BranchRow {
  folder: string;
  folderDisplayName: string;
}

/** Pick the "primary" PR from a branch's PR list (first open non-draft, else open draft, else most recent). */
function primaryPr(prs: PrInfo[]): PrInfo | null {
  if (!prs || prs.length === 0) return null;
  return prs[0];
}

function totalUnresolved(prs: PrInfo[]): number {
  let n = 0;
  for (const p of prs) if (p.state === "open") n += p.openUnresolvedThreads;
  return n;
}

function compareRows(a: FlatRow, b: FlatRow, key: SortKey, dir: SortDir): number {
  const mul = dir === "asc" ? 1 : -1;
  const pa = primaryPr(a.prs);
  const pb = primaryPr(b.prs);
  let av: string | number;
  let bv: string | number;
  switch (key) {
    case "branch":
      av = a.branch;
      bv = b.branch;
      break;
    case "folder":
      av = a.folderDisplayName;
      bv = b.folderDisplayName;
      break;
    case "worktree":
      av = a.worktreePath || "";
      bv = b.worktreePath || "";
      break;
    case "ahead":
      av = a.ahead;
      bv = b.ahead;
      break;
    case "behind":
      av = a.behind;
      bv = b.behind;
      break;
    case "lastCommit":
      av = a.lastCommit?.committedAt || "";
      bv = b.lastCommit?.committedAt || "";
      break;
    case "pr":
      av = pa?.number ?? -1;
      bv = pb?.number ?? -1;
      break;
    case "prState": {
      const rank = (p: PrInfo | null) => (!p ? 99 : p.state === "open" && !p.isDraft ? 0 : p.state === "open" ? 1 : p.state === "merged" ? 2 : 3);
      av = rank(pa);
      bv = rank(pb);
      break;
    }
    case "approved": {
      const rank = (p: PrInfo | null) => (!p ? 99 : p.reviewDecision === "APPROVED" ? 0 : p.reviewDecision === "CHANGES_REQUESTED" ? 1 : 2);
      av = rank(pa);
      bv = rank(pb);
      break;
    }
    case "comments":
      av = totalUnresolved(a.prs);
      bv = totalUnresolved(b.prs);
      break;
    case "checks": {
      const rank = (p: PrInfo | null) => (!p || p.checksStatus === null ? 99 : p.checksStatus === "failure" ? 0 : p.checksStatus === "pending" ? 1 : 2);
      av = rank(pa);
      bv = rank(pb);
      break;
    }
  }
  if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul;
  return String(av).localeCompare(String(bv)) * mul;
}

interface SortHeaderProps {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right" | "center";
  width?: number | string;
}

function SortHeader({ label, sortKey, currentKey, currentDir, onSort, align = "left", width }: SortHeaderProps) {
  const active = currentKey === sortKey;
  const Icon = !active ? ChevronsUpDown : currentDir === "asc" ? ChevronUp : ChevronDown;
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{
        padding: "10px 12px",
        textAlign: align,
        fontSize: 12,
        fontWeight: 600,
        color: active ? "var(--text)" : "var(--text-muted)",
        textTransform: "uppercase",
        letterSpacing: 0.4,
        cursor: "pointer",
        userSelect: "none",
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        position: "sticky",
        top: 0,
        zIndex: 1,
        whiteSpace: "nowrap",
        width,
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start" }}>
        {label}
        <Icon size={12} style={{ opacity: active ? 1 : 0.5 }} />
      </span>
    </th>
  );
}

function PrStateBadge({ pr }: { pr: PrInfo }) {
  let color: string;
  let bg: string;
  let label: string;
  if (pr.state === "merged") {
    color = "var(--pr-merged, var(--accent))";
    bg = "color-mix(in srgb, var(--pr-merged, var(--accent)) 15%, transparent)";
    label = "Merged";
  } else if (pr.state === "closed") {
    color = "var(--danger)";
    bg = "color-mix(in srgb, var(--danger) 15%, transparent)";
    label = "Closed";
  } else if (pr.isDraft) {
    color = "var(--text-muted)";
    bg = "color-mix(in srgb, var(--text-muted) 15%, transparent)";
    label = "Draft";
  } else {
    color = "var(--success, var(--accent))";
    bg = "color-mix(in srgb, var(--success, var(--accent)) 15%, transparent)";
    label = "Open";
  }
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color,
        background: bg,
        padding: "2px 8px",
        borderRadius: 10,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function ApprovedCell({ pr }: { pr: PrInfo | null }) {
  if (!pr) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  if (pr.reviewDecision === "APPROVED") {
    return <Check size={16} style={{ color: "var(--success, var(--accent))" }} />;
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return <X size={16} style={{ color: "var(--danger)" }} />;
  }
  return <CircleDashed size={16} style={{ color: "var(--text-muted)" }} />;
}

function ChecksCell({ pr }: { pr: PrInfo | null }) {
  if (!pr || pr.checksStatus === null) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  if (pr.checksStatus === "success") return <Check size={16} style={{ color: "var(--success, var(--accent))" }} />;
  if (pr.checksStatus === "failure") return <X size={16} style={{ color: "var(--danger)" }} />;
  return <Clock size={16} style={{ color: "var(--text-muted)" }} />;
}

function PrNumberCell({ prs }: { prs: PrInfo[] }) {
  const primary = primaryPr(prs);
  if (!primary) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const extra = prs.length - 1;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
      <a
        href={primary.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ color: "var(--accent)", fontWeight: 500, textDecoration: "none" }}
        title={primary.title || `PR #${primary.number}`}
      >
        #{primary.number}
      </a>
      {extra > 0 && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "var(--text-muted)",
            background: "var(--bg-secondary)",
            padding: "1px 6px",
            borderRadius: 8,
          }}
          title={`${extra} additional PR${extra === 1 ? "" : "s"}`}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}

function CommentsCell({ prs }: { prs: PrInfo[] }) {
  const count = totalUnresolved(prs);
  if (count === 0) {
    return prs.length === 0 ? <span style={{ color: "var(--text-muted)" }}>—</span> : <span style={{ color: "var(--text-muted)" }}>0</span>;
  }
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        color: "var(--danger)",
        fontWeight: 600,
      }}
      title={`${count} unresolved review thread${count === 1 ? "" : "s"}`}
    >
      <MessageSquareWarning size={14} />
      {count}
    </span>
  );
}

interface Filters {
  search: string;
  hasWorktree: boolean;
  hasOpenPr: boolean;
  hasUnresolved: boolean;
}

export default function BranchTable() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>("all");
  const [overview, setOverview] = useState<BranchOverviewFolder[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [prFetchedAt, setPrFetchedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("folder");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [filters, setFilters] = useState<Filters>({ search: "", hasWorktree: false, hasOpenPr: false, hasUnresolved: false });
  const abortRef = useRef<AbortController | null>(null);

  const loadFolders = useCallback(async () => {
    try {
      const resp = await listFolders(30);
      const gitFolders = resp.folders.filter((f) => f.isGitRepo);
      setFolders(gitFolders);
      return gitFolders;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load folders");
      return [];
    }
  }, []);

  const loadOverview = useCallback(
    async (gitFolders: FolderSummary[], scope: string, refresh: boolean) => {
      if (gitFolders.length === 0) {
        setOverview([]);
        setFetchedAt(new Date().toISOString());
        return;
      }
      // Abort any in-flight load
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const targets = scope === "all" ? gitFolders.map((f) => f.folder) : [scope];
      try {
        const results = await Promise.all(
          targets.map(async (folder) => {
            try {
              return await getBranchOverview(folder, refresh);
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to load branches";
              return {
                folders: [
                  {
                    folder,
                    displayName: folder.split("/").pop() || folder,
                    branches: [],
                    prsEnriched: false,
                    error: message,
                  },
                ],
                fetchedAt: new Date().toISOString(),
                prFetchedAt: null,
              };
            }
          }),
        );
        if (controller.signal.aborted) return;

        // Merge & dedupe by main-repo folder path (worktrees of the same repo share branches)
        const merged = new Map<string, BranchOverviewFolder>();
        let latestPrTime: string | null = null;
        for (const r of results) {
          if (r.prFetchedAt && (!latestPrTime || r.prFetchedAt > latestPrTime)) latestPrTime = r.prFetchedAt;
          for (const f of r.folders) {
            if (!merged.has(f.folder)) merged.set(f.folder, f);
          }
        }
        const list = [...merged.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
        setOverview(list);
        setFetchedAt(new Date().toISOString());
        setPrFetchedAt(latestPrTime);
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Failed to load branch overview");
        }
      }
    },
    [],
  );

  useEffect(() => {
    (async () => {
      setLoading(true);
      const gitFolders = await loadFolders();
      await loadOverview(gitFolders, selectedFolder, false);
      setLoading(false);
    })();
  }, [loadFolders, loadOverview, selectedFolder]);

  // 30s polling
  useEffect(() => {
    const id = setInterval(() => {
      loadOverview(folders, selectedFolder, false);
    }, 30_000);
    return () => clearInterval(id);
  }, [folders, selectedFolder, loadOverview]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadOverview(folders, selectedFolder, true);
    setRefreshing(false);
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    for (const f of overview) {
      for (const b of f.branches) {
        rows.push({ ...b, folder: f.folder, folderDisplayName: f.displayName });
      }
    }
    return rows;
  }, [overview]);

  const filteredRows = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return flatRows.filter((r) => {
      if (q && !r.branch.toLowerCase().includes(q) && !r.folderDisplayName.toLowerCase().includes(q)) return false;
      if (filters.hasWorktree && !r.worktreePath) return false;
      if (filters.hasOpenPr && !r.prs.some((p) => p.state === "open")) return false;
      if (filters.hasUnresolved && totalUnresolved(r.prs) === 0) return false;
      return true;
    });
  }, [flatRows, filters]);

  const sortedRows = useMemo(() => {
    const copy = [...filteredRows];
    copy.sort((a, b) => compareRows(a, b, sortKey, sortDir));
    return copy;
  }, [filteredRows, sortKey, sortDir]);

  const showFolderColumn = selectedFolder === "all";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{
          padding: isMobile ? "12px 16px" : "16px 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexShrink: 0,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <GitBranch size={20} style={{ color: "var(--accent)" }} />
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Branches</h1>
          {fetchedAt && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }} title={`Git: ${fetchedAt}${prFetchedAt ? `\nPRs: ${prFetchedAt}` : ""}`}>
              updated {formatRelativeTime(fetchedAt)}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <select
            value={selectedFolder}
            onChange={(e) => setSelectedFolder(e.target.value)}
            style={{
              background: "var(--bg-secondary)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 13,
            }}
          >
            <option value="all">All repositories</option>
            {folders.map((f) => (
              <option key={f.folder} value={f.folder}>
                {f.displayName}
              </option>
            ))}
          </select>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "var(--bg-secondary)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 12px",
              fontSize: 13,
              cursor: refreshing ? "not-allowed" : "pointer",
              opacity: refreshing ? 0.6 : 1,
            }}
            title="Refresh now"
          >
            <RefreshCw size={14} style={{ animation: refreshing ? "spin 1s linear infinite" : undefined }} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div
        style={{
          padding: isMobile ? "8px 16px" : "10px 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          flexShrink: 0,
        }}
      >
        <input
          type="text"
          placeholder="Search branch or repo..."
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          style={{
            background: "var(--bg-secondary)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "6px 10px",
            fontSize: 13,
            minWidth: 200,
            flex: "0 1 260px",
          }}
        />
        <FilterToggle label="Has worktree" value={filters.hasWorktree} onChange={(v) => setFilters((f) => ({ ...f, hasWorktree: v }))} />
        <FilterToggle label="Has open PR" value={filters.hasOpenPr} onChange={(v) => setFilters((f) => ({ ...f, hasOpenPr: v }))} />
        <FilterToggle label="Unresolved comments" value={filters.hasUnresolved} onChange={(v) => setFilters((f) => ({ ...f, hasUnresolved: v }))} />
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-muted)" }}>
          {sortedRows.length} / {flatRows.length} branches
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            padding: "10px 20px",
            background: "color-mix(in srgb, var(--danger) 10%, transparent)",
            color: "var(--danger)",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <AlertCircle size={14} />
          {error}
          <button onClick={() => setError(null)} style={{ marginLeft: "auto", background: "transparent", border: "none", color: "var(--danger)", cursor: "pointer" }}>
            Dismiss
          </button>
        </div>
      )}

      {/* Table */}
      <div style={{ flex: 1, overflow: "auto", background: "var(--bg)" }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>
        ) : sortedRows.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>
            {flatRows.length === 0 ? "No git repositories found in your recent folders." : "No branches match the current filters."}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <SortHeader label="Branch" sortKey="branch" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                {showFolderColumn && <SortHeader label="Repo" sortKey="folder" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />}
                <SortHeader label="Worktree" sortKey="worktree" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                <SortHeader label="Ahead" sortKey="ahead" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="right" width={70} />
                <SortHeader label="Behind" sortKey="behind" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="right" width={70} />
                <SortHeader label="Last commit" sortKey="lastCommit" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                <SortHeader label="PR" sortKey="pr" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} width={100} />
                <SortHeader label="State" sortKey="prState" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} width={90} />
                <SortHeader label="Approved" sortKey="approved" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="center" width={80} />
                <SortHeader label="Comments" sortKey="comments" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="center" width={90} />
                <SortHeader label="Checks" sortKey="checks" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="center" width={70} />
                <th
                  style={{
                    padding: "10px 12px",
                    background: "var(--surface)",
                    borderBottom: "1px solid var(--border)",
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                    width: 60,
                  }}
                />
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const primary = primaryPr(row.prs);
                const commitRel = row.lastCommit?.committedAt ? formatRelativeTime(row.lastCommit.committedAt) : "";
                const openChat = row.worktreePath
                  ? () => {
                      const matching = folders.find((f) => f.folder === row.worktreePath);
                      if (matching?.mostRecentChatId) navigate(`/chat/${matching.mostRecentChatId}`);
                    }
                  : undefined;
                return (
                  <tr
                    key={`${row.folder}::${row.branch}`}
                    style={{
                      borderBottom: "1px solid var(--border)",
                      transition: "background 0.15s",
                      cursor: openChat ? "pointer" : "default",
                    }}
                    onClick={openChat}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={cell}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {row.isCurrent && <span title="Current branch" style={{ color: "var(--accent)", fontSize: 10 }}>●</span>}
                        <span style={{ fontFamily: "monospace", fontWeight: row.isCurrent ? 600 : 400, color: "var(--text)" }}>{row.branch}</span>
                      </span>
                    </td>
                    {showFolderColumn && <td style={cell}>{row.folderDisplayName}</td>}
                    <td style={{ ...cell, color: "var(--text-muted)", fontFamily: "monospace", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.worktreePath || ""}>
                      {row.worktreePath ? row.worktreePath.split("/").slice(-2).join("/") : <span style={{ opacity: 0.5 }}>—</span>}
                    </td>
                    <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {row.ahead > 0 ? <span style={{ color: "var(--accent)" }}>+{row.ahead}</span> : <span style={{ color: "var(--text-muted)" }}>0</span>}
                    </td>
                    <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {row.behind > 0 ? <span style={{ color: "var(--danger)" }}>−{row.behind}</span> : <span style={{ color: "var(--text-muted)" }}>0</span>}
                    </td>
                    <td style={{ ...cell, color: "var(--text-muted)" }} title={row.lastCommit ? `${row.lastCommit.author}\n${row.lastCommit.subject}\n${row.lastCommit.committedAt}` : ""}>
                      {row.lastCommit ? (
                        <span>
                          <span style={{ color: "var(--text)" }}>{commitRel}</span>
                          <span style={{ opacity: 0.7 }}> · {row.lastCommit.author}</span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={cell}>
                      <PrNumberCell prs={row.prs} />
                    </td>
                    <td style={cell}>{primary ? <PrStateBadge pr={primary} /> : <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                    <td style={{ ...cell, textAlign: "center" }}>
                      <ApprovedCell pr={primary} />
                    </td>
                    <td style={{ ...cell, textAlign: "center" }}>
                      <CommentsCell prs={row.prs} />
                    </td>
                    <td style={{ ...cell, textAlign: "center" }}>
                      <ChecksCell pr={primary} />
                    </td>
                    <td style={{ ...cell, textAlign: "center" }}>
                      {primary && (
                        <a
                          href={primary.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          style={{ color: "var(--text-muted)", display: "inline-flex" }}
                          title="Open PR"
                        >
                          <ExternalLink size={14} />
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }`}</style>
    </div>
  );
}

const cell: React.CSSProperties = {
  padding: "10px 12px",
  verticalAlign: "middle",
  color: "var(--text)",
};

function FilterToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: value ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer",
        userSelect: "none",
        padding: "4px 10px",
        borderRadius: 6,
        border: `1px solid ${value ? "var(--accent)" : "var(--border)"}`,
        background: value ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
      }}
    >
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} style={{ margin: 0 }} />
      {label}
    </label>
  );
}
