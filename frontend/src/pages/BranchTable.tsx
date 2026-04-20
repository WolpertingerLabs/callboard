import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  RefreshCw,
  GitBranch,
  ExternalLink,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  Check,
  X,
  Clock,
  CircleDashed,
  AlertCircle,
  MessageSquare,
  GitMerge,
  Trash2,
  FolderMinus,
  ArrowUpCircle,
  CircleDot,
} from "lucide-react";
import {
  listFolders,
  getBranchOverview,
  deleteLocalBranch,
  removeGitWorktree,
  type BranchOverviewFolder,
  type BranchRow,
  type FolderSummary,
  type PrInfo,
} from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import { formatRelativeTime } from "../utils/dateFormat";

type SortKey = "branch" | "folder" | "worktree" | "ahead" | "behind" | "lastCommit" | "pr" | "prState" | "approved" | "comments" | "checks";

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

function threadTotals(prs: PrInfo[]): { total: number; unresolved: number; resolved: number } {
  let total = 0;
  let unresolved = 0;
  for (const p of prs) {
    total += p.totalThreads;
    unresolved += p.openUnresolvedThreads;
  }
  return { total, unresolved, resolved: total - unresolved };
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
      av = threadTotals(a.prs).unresolved;
      bv = threadTotals(b.prs).unresolved;
      break;
    case "checks": {
      const rank = (p: PrInfo | null) => {
        if (!p || !p.checks) return 99;
        const r = p.checks.rollup;
        // Failures ranked by how many; more failures = worse.
        if (r === "failure") return -p.checks.failure;
        if (r === "pending") return 100;
        return 200;
      };
      av = rank(pa);
      bv = rank(pb);
      break;
    }
  }
  const primary = typeof av === "number" && typeof bv === "number" ? (av - bv) * mul : String(av).localeCompare(String(bv)) * mul;
  if (primary !== 0) return primary;
  // Secondary sort: most recent commit first when primary sort ties.
  const at = a.lastCommit?.committedAt || "";
  const bt = b.lastCommit?.committedAt || "";
  if (at === bt) return 0;
  return at < bt ? 1 : -1;
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
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start",
        }}
      >
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
  if (!pr || !pr.checks) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const { rollup, total, success, failure, pending, neutral, items } = pr.checks;

  const summary = `✓ ${success}   ✗ ${failure}   ⏱ ${pending}${neutral ? `   ○ ${neutral}` : ""}   (total ${total})`;
  const failed = items.filter(
    (i) => i.conclusion === "failure" || i.conclusion === "timed_out" || i.conclusion === "cancelled" || i.conclusion === "action_required",
  );
  const pendingNames = items.filter((i) => i.conclusion === null);
  const tipLines = [summary];
  if (failed.length) tipLines.push(`Failed: ${failed.map((i) => i.name).join(" · ")}`);
  if (pendingNames.length && !failed.length) tipLines.push(`Pending: ${pendingNames.map((i) => i.name).join(" · ")}`);
  const title = tipLines.join("\n");

  const icon =
    rollup === "success" ? (
      <Check size={16} style={{ color: "var(--success, var(--accent))" }} />
    ) : rollup === "failure" ? (
      <X size={16} style={{ color: "var(--danger)" }} />
    ) : (
      <Clock size={16} style={{ color: "var(--text-muted)" }} />
    );

  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center" }}>
      {icon}
    </span>
  );
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
  if (prs.length === 0) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const { total, resolved } = threadTotals(prs);
  if (total === 0) return <span style={{ color: "var(--text-muted)" }}>0</span>;
  const allResolved = resolved === total;
  const color = allResolved ? "var(--text-muted)" : "var(--warning, var(--danger))";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        color,
        fontWeight: allResolved ? 400 : 600,
        fontVariantNumeric: "tabular-nums",
      }}
      title={`${resolved} of ${total} review thread${total === 1 ? "" : "s"} resolved`}
    >
      <MessageSquare size={14} />
      {resolved}/{total}
    </span>
  );
}

function MergeConflictCell({ row }: { row: FlatRow }) {
  if (row.hasMergeConflict === null || row.hasMergeConflict === undefined) {
    return <span style={{ color: "var(--text-muted)" }}>—</span>;
  }
  if (!row.hasMergeConflict) {
    return (
      <span title={row.mergeConflictBase ? `Merges cleanly into ${row.mergeConflictBase}` : "Merges cleanly"}>
        <Check size={16} style={{ color: "var(--success, var(--accent))" }} />
      </span>
    );
  }
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        color: "var(--warning, var(--danger))",
        fontWeight: 600,
      }}
      title={row.mergeConflictBase ? `Conflicts with ${row.mergeConflictBase}` : "Conflicts with base"}
    >
      <GitMerge size={14} />
    </span>
  );
}

interface Filters {
  search: string;
  hasWorktree: boolean;
  hasPr: boolean;
  hasUnresolved: boolean;
  hasConflict: boolean;
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
  const [filters, setFilters] = useState<Filters>({ search: "", hasWorktree: false, hasPr: false, hasUnresolved: false, hasConflict: false });
  const [pageSize, setPageSize] = useState<number>(25);
  const [page, setPage] = useState<number>(1);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "branch" | "worktree"; row: FlatRow } | null>(null);
  const [deleting, setDeleting] = useState(false);
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

  const loadOverview = useCallback(async (gitFolders: FolderSummary[], scope: string, refresh: boolean) => {
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
  }, []);

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

  const handleConfirmDelete = useCallback(
    async (force: boolean) => {
      if (!pendingDelete) return;
      const { kind, row } = pendingDelete;
      setDeleting(true);
      try {
        if (kind === "branch") {
          await deleteLocalBranch(row.folder, row.branch, force);
        } else {
          if (!row.worktreePath) throw new Error("No worktree to remove");
          await removeGitWorktree(row.folder, row.worktreePath, force);
        }
        setPendingDelete(null);
        await loadOverview(folders, selectedFolder, true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Delete failed");
      } finally {
        setDeleting(false);
      }
    },
    [pendingDelete, folders, selectedFolder, loadOverview],
  );

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
      if (filters.hasPr && r.prs.length === 0) return false;
      if (filters.hasUnresolved && threadTotals(r.prs).unresolved === 0) return false;
      if (filters.hasConflict && r.hasMergeConflict !== true) return false;
      return true;
    });
  }, [flatRows, filters]);

  const sortedRows = useMemo(() => {
    const copy = [...filteredRows];
    copy.sort((a, b) => compareRows(a, b, sortKey, sortDir));
    return copy;
  }, [filteredRows, sortKey, sortDir]);

  // Reset to first page whenever filters/sort change — React's "store prev value" pattern.
  const resetKey = `${filters.search}|${filters.hasWorktree}|${filters.hasPr}|${filters.hasUnresolved}|${filters.hasConflict}|${sortKey}|${sortDir}|${selectedFolder}|${pageSize}`;
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    if (page !== 1) setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pagedRows = useMemo(() => sortedRows.slice(pageStart, pageStart + pageSize), [sortedRows, pageStart, pageSize]);

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
          {isMobile && (
            <button
              onClick={() => navigate("/")}
              style={{
                background: "none",
                padding: "4px 8px",
                display: "flex",
                alignItems: "center",
                color: "var(--text)",
              }}
            >
              <ChevronLeft size={20} />
            </button>
          )}
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
        <FilterToggle label="Has PR" value={filters.hasPr} onChange={(v) => setFilters((f) => ({ ...f, hasPr: v }))} />
        <FilterToggle label="Unresolved comments" value={filters.hasUnresolved} onChange={(v) => setFilters((f) => ({ ...f, hasUnresolved: v }))} />
        <FilterToggle label="Merge conflict" value={filters.hasConflict} onChange={(v) => setFilters((f) => ({ ...f, hasConflict: v }))} />
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
          <button
            onClick={() => setError(null)}
            style={{ marginLeft: "auto", background: "transparent", border: "none", color: "var(--danger)", cursor: "pointer" }}
          >
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
                    textAlign: "center",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                    background: "var(--surface)",
                    borderBottom: "1px solid var(--border)",
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                    whiteSpace: "nowrap",
                    width: 80,
                  }}
                  title="Merge status vs base branch"
                >
                  Merge
                </th>
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
              {pagedRows.map((row) => {
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
                        {row.isCurrent && (
                          <span title="Current branch" style={{ color: "var(--accent)", fontSize: 10 }}>
                            ●
                          </span>
                        )}
                        <span style={{ fontFamily: "monospace", fontWeight: row.isCurrent ? 600 : 400, color: "var(--text)" }}>{row.branch}</span>
                      </span>
                    </td>
                    {showFolderColumn && <td style={cell}>{row.folderDisplayName}</td>}
                    <td
                      style={{
                        ...cell,
                        color: "var(--text-muted)",
                        fontFamily: "monospace",
                        maxWidth: 300,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={row.worktreePath || ""}
                    >
                      {row.worktreePath ? row.worktreePath.split("/").slice(-2).join("/") : <span style={{ opacity: 0.5 }}>—</span>}
                    </td>
                    <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {row.ahead > 0 ? <span style={{ color: "var(--accent)" }}>+{row.ahead}</span> : <span style={{ color: "var(--text-muted)" }}>0</span>}
                    </td>
                    <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {row.behind > 0 ? <span style={{ color: "var(--danger)" }}>−{row.behind}</span> : <span style={{ color: "var(--text-muted)" }}>0</span>}
                    </td>
                    <td
                      style={{ ...cell, color: "var(--text-muted)" }}
                      title={row.lastCommit ? `${row.lastCommit.author}\n${row.lastCommit.subject}\n${row.lastCommit.committedAt}` : ""}
                    >
                      {row.lastCommit ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span style={{ color: "var(--text)" }}>{commitRel}</span>
                          <span style={{ opacity: 0.7 }}> · {row.lastCommit.author}</span>
                          <StatusBadges row={row} />
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
                      <MergeConflictCell row={row} />
                    </td>
                    <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
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
                        {row.worktreePath && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDelete({ kind: "worktree", row });
                            }}
                            title={`Remove worktree at ${row.worktreePath}`}
                            aria-label="Remove worktree"
                            style={iconButtonStyle}
                          >
                            <FolderMinus size={14} />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (row.isCurrent || row.worktreePath) return;
                            setPendingDelete({ kind: "branch", row });
                          }}
                          disabled={row.isCurrent || !!row.worktreePath}
                          title={row.isCurrent ? "Cannot delete the current branch" : row.worktreePath ? "Remove the worktree first" : "Delete local branch"}
                          aria-label="Delete branch"
                          style={{
                            ...iconButtonStyle,
                            color: row.isCurrent || row.worktreePath ? "var(--text-muted)" : "var(--danger)",
                            opacity: row.isCurrent || row.worktreePath ? 0.35 : 1,
                            cursor: row.isCurrent || row.worktreePath ? "not-allowed" : "pointer",
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {/* Pagination */}
      {!loading && sortedRows.length > 0 && (
        <Pagination
          page={safePage}
          totalPages={totalPages}
          pageSize={pageSize}
          totalRows={sortedRows.length}
          pageStart={pageStart}
          pageEnd={Math.min(pageStart + pageSize, sortedRows.length)}
          onPage={setPage}
          onPageSize={setPageSize}
          isMobile={isMobile}
        />
      )}
      {pendingDelete && (
        <ConfirmModal
          kind={pendingDelete.kind}
          row={pendingDelete.row}
          busy={deleting}
          onCancel={() => (deleting ? undefined : setPendingDelete(null))}
          onConfirm={handleConfirmDelete}
        />
      )}
      <style>{`@keyframes spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }`}</style>
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 26,
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 6,
  color: "var(--text-muted)",
  cursor: "pointer",
  padding: 0,
};

function StatusBadges({ row }: { row: FlatRow }) {
  const badges: React.ReactNode[] = [];
  if (row.hasUncommittedChanges) {
    badges.push(
      <span
        key="uncommitted"
        title="Uncommitted changes in worktree"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          fontSize: 11,
          color: "var(--warning, var(--danger))",
          fontWeight: 600,
        }}
      >
        <CircleDot size={12} />
        uncommitted
      </span>,
    );
  }
  if (row.hasUnpushedCommits) {
    const n = row.unpushedCount || 0;
    badges.push(
      <span
        key="unpushed"
        title={n ? `${n} commit${n === 1 ? "" : "s"} not pushed to origin/${row.branch}` : "Unpushed commits"}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          fontSize: 11,
          color: "var(--accent)",
          fontWeight: 600,
        }}
      >
        <ArrowUpCircle size={12} />
        {n ? `${n} unpushed` : "unpushed"}
      </span>,
    );
  }
  if (badges.length === 0) return null;
  return <>{badges}</>;
}

interface ConfirmModalProps {
  kind: "branch" | "worktree";
  row: FlatRow;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (force: boolean) => void;
}

function ConfirmModal({ kind, row, busy, onCancel, onConfirm }: ConfirmModalProps) {
  const needsForce = kind === "worktree" ? !!row.hasUncommittedChanges || row.ahead > 0 : row.ahead > 0 || !!row.hasUnpushedCommits;
  const [force, setForce] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  const title = kind === "branch" ? `Delete branch “${row.branch}”?` : "Remove worktree?";
  const confirmDisabled = busy || (needsForce && !force);

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--overlay-bg, rgba(0,0,0,0.5))",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        style={{
          background: "var(--surface)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "var(--shadow-md, 0 10px 30px rgba(0,0,0,0.4))",
          maxWidth: 480,
          width: "100%",
          padding: 20,
        }}
      >
        <h2 id="confirm-delete-title" style={{ fontSize: 16, fontWeight: 600, margin: 0, marginBottom: 10 }}>
          {title}
        </h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 6 }}>
          {kind === "branch" ? (
            <>
              <div>
                Repo: <span style={{ color: "var(--text)", fontFamily: "monospace" }}>{row.folderDisplayName}</span>
              </div>
              <div>
                Branch: <span style={{ color: "var(--text)", fontFamily: "monospace" }}>{row.branch}</span>
              </div>
              {row.hasUnpushedCommits && <div style={{ color: "var(--warning, var(--danger))" }}>This branch has unpushed commits.</div>}
              {row.ahead > 0 && !row.hasUnpushedCommits && <div style={{ color: "var(--warning, var(--danger))" }}>This branch is ahead of its upstream.</div>}
            </>
          ) : (
            <>
              <div>
                Worktree: <span style={{ color: "var(--text)", fontFamily: "monospace" }}>{row.worktreePath}</span>
              </div>
              <div>
                Branch: <span style={{ color: "var(--text)", fontFamily: "monospace" }}>{row.branch}</span>
              </div>
              {row.hasUncommittedChanges && <div style={{ color: "var(--warning, var(--danger))" }}>Worktree has uncommitted changes.</div>}
            </>
          )}
        </div>

        {needsForce && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 14,
              padding: 10,
              background: "color-mix(in srgb, var(--warning, var(--danger)) 10%, transparent)",
              border: "1px solid var(--warning, var(--danger))",
              borderRadius: 6,
              fontSize: 13,
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Force {kind === "branch" ? "delete (discards unmerged commits)" : "remove (discards uncommitted changes)"}
          </label>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              background: "var(--bg-secondary)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "8px 14px",
              fontSize: 13,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(force)}
            disabled={confirmDisabled}
            style={{
              background: "var(--danger)",
              color: "var(--text-on-accent, #fff)",
              border: "1px solid var(--danger)",
              borderRadius: 6,
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 600,
              cursor: confirmDisabled ? "not-allowed" : "pointer",
              opacity: confirmDisabled ? 0.5 : 1,
            }}
          >
            {busy ? "Working…" : kind === "branch" ? "Delete branch" : "Remove worktree"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PaginationProps {
  page: number;
  totalPages: number;
  pageSize: number;
  totalRows: number;
  pageStart: number;
  pageEnd: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
  isMobile: boolean;
}

function Pagination({ page, totalPages, pageSize, totalRows, pageStart, pageEnd, onPage, onPageSize, isMobile }: PaginationProps) {
  const btnStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 36,
    height: 32,
    padding: "0 10px",
    fontSize: 13,
    background: "var(--bg-secondary)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    cursor: "pointer",
  };
  const disabledStyle: React.CSSProperties = { opacity: 0.4, cursor: "not-allowed" };

  return (
    <div
      style={{
        padding: isMobile ? "10px 16px" : "10px 20px",
        borderTop: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexShrink: 0,
        flexWrap: "wrap",
      }}
    >
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{totalRows === 0 ? "0 results" : `${pageStart + 1}–${pageEnd} of ${totalRows}`}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {!isMobile && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
            Rows
            <select
              value={pageSize}
              onChange={(e) => onPageSize(parseInt(e.target.value, 10))}
              style={{
                background: "var(--bg-secondary)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "4px 8px",
                fontSize: 13,
              }}
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          style={{ ...btnStyle, ...(page <= 1 ? disabledStyle : {}) }}
          aria-label="Previous page"
          title="Previous page"
        >
          <ChevronLeft size={16} />
        </button>
        <span
          style={{
            fontSize: 13,
            color: "var(--text)",
            fontVariantNumeric: "tabular-nums",
            minWidth: 70,
            textAlign: "center",
          }}
        >
          {page} / {totalPages}
        </span>
        <button
          onClick={() => onPage(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          style={{ ...btnStyle, ...(page >= totalPages ? disabledStyle : {}) }}
          aria-label="Next page"
          title="Next page"
        >
          <ChevronRight size={16} />
        </button>
      </div>
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
