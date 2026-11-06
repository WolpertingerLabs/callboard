import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { BranchRepo, BranchRow, CardSummary, GitOverviewResponse } from "../../api";
import { getGitOverview } from "../../api";
import { useIsMobile } from "../../hooks/useIsMobile";
import { usePolling } from "../../hooks/usePolling";
import { startTimedRequest, type TimedRequest } from "../git/timedRequest";
import { errorMessage } from "../../utils/errorMessage";
import { formatShortAgo } from "../../utils/dateFormat";
import { ROLLUP_COLORS } from "./cardFace";
import CardPathLabel from "./CardPathLabel";
import PrBadge from "../git/PrBadge";

interface BranchesViewProps {
  /**
   * The cards the board already holds. Rows carry only card ids; titles and
   * status come from here, so this view never refetches cards — and a card
   * the board is not showing (another space) is not shown as a chip either.
   */
  cards: CardSummary[];
  onOpenCard: (cardId: string) => void;
}

/** Chips shown on a row before the rest fold behind "+N more". */
const CHIP_LIMIT = 4;

/** `parent/` of the repo, so rows read `callboard.feat-x` rather than the whole path. */
function parentPrefix(repoPath: string): string {
  const cut = repoPath.lastIndexOf("/");
  return cut > 0 ? repoPath.slice(0, cut) : "";
}

/**
 * The Board's Branches view: one row per worktree that open cards are working
 * in, grouped by repository, with those cards attached as chips. Read-only —
 * selection, archiving and clean-up all live in the other two views.
 */
export default function BranchesView({ cards, onOpenCard }: BranchesViewProps) {
  const isMobile = useIsMobile();
  const [data, setData] = useState<GitOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The mount request is a forced refresh, so the button starts disabled.
  const [refreshing, setRefreshing] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
  // Only the newest request may land: a slow poll must not overwrite a refresh.
  const seq = useRef(0);
  // The seq of the newest forced refresh still in flight; 0 when none is.
  const refreshInFlight = useRef(0);
  // Requests not yet settled, so an unmount can abort them.
  const pending = useRef(new Set<TimedRequest>());

  const load = useCallback(async (refresh = false) => {
    const mine = ++seq.current;
    if (refresh) {
      refreshInFlight.current = mine;
      setRefreshing(true);
    }
    // Every request times out, so `finally` always runs: a request left
    // pending forever would keep the button disabled and polls paused.
    const timed = startTimedRequest();
    pending.current.add(timed);
    try {
      const res = await getGitOverview(refresh, timed.signal);
      if (mine !== seq.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(timed.timedOut() ? "Timed out loading branches — try refreshing." : errorMessage(err, "Failed to load branches"));
    } finally {
      timed.done();
      pending.current.delete(timed);
      // Only the newest forced request re-enables the button — a poll never
      // does (polls do not even start while a refresh is in flight).
      if (refresh && refreshInFlight.current === mine) {
        refreshInFlight.current = 0;
        setRefreshing(false);
      }
      setNow(Date.now());
    }
  }, []);

  // The one request a mount makes is forced — the same request as the refresh
  // button, which the daemon bounds (a fresh-enough cache is reused; a slow
  // GitHub is waited on briefly). Switching to this tab remounts it.
  useEffect(() => {
    void load(true);
  }, [load]);

  // Going away: abort what is in flight, and let nothing that settles land.
  useEffect(() => {
    const requests = pending.current;
    const sequence = seq;
    return () => {
      sequence.current++;
      for (const request of requests) request.abort();
    };
  }, []);

  // Branches and PRs move slowly: background polls are not forced, and do not
  // start while a refresh is in flight.
  usePolling(() => {
    if (refreshInFlight.current === 0) void load();
  }, 60_000);
  // Keeps "updated Xs ago" honest between polls.
  usePolling(() => setNow(Date.now()), 10_000, { catchUp: false });

  const openCards = new Map(cards.filter((c) => c.lifecycle === "open").map((c) => [c.id, c]));
  const chipsOf = (row: BranchRow) => row.cardIds.map((id) => openCards.get(id)).filter((c): c is CardSummary => c !== undefined);

  // The daemon only sends worktrees with open cards in them; a row is shown
  // when at least one of those is a card the board shows (not, say, one from
  // another space), and a repo when any of its rows is. Main checkout first.
  const repos = (data?.repos ?? [])
    .map((repo) => ({
      repo,
      rows: repo.rows
        .map((row) => ({ row, chips: chipsOf(row) }))
        .filter(({ chips }) => chips.length > 0)
        .sort((a, b) => Number(b.row.isMain) - Number(a.row.isMain)),
    }))
    .filter(({ rows }) => rows.length > 0);

  const toggleRow = (cwd: string) =>
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });

  /**
   * Every PR badge on a row: `prs` when the git trail added earlier branches'
   * PRs (live one first), else the live `pr` alone — which is all a daemon
   * predating the trail sends.
   */
  const prBadge = (row: BranchRow) => {
    const prs = row.prs ?? (row.pr ? [row.pr] : []);
    if (prs.length === 0) return <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", flexShrink: 0 }}>no PR</span>;
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {prs.map((pr) => (
          <PrBadge key={pr.url} pr={pr} />
        ))}
      </div>
    );
  };

  const chipList = (row: BranchRow, chips: CardSummary[]) => {
    const expanded = expandedRows.has(row.cwd);
    const shown = expanded ? chips : chips.slice(0, CHIP_LIMIT);
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, minWidth: 0 }}>
        {shown.map((card) => (
          <button
            key={card.id}
            onClick={() => onOpenCard(card.id)}
            title={card.title}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              maxWidth: 220,
              padding: "2px 8px",
              borderRadius: 10,
              fontSize: 11,
              background: "var(--surface)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              cursor: "pointer",
            }}
          >
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: ROLLUP_COLORS[card.rollup] }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.title}</span>
          </button>
        ))}
        {chips.length > CHIP_LIMIT && (
          <button
            onClick={() => toggleRow(row.cwd)}
            style={{ padding: "2px 6px", fontSize: 11, background: "transparent", color: "var(--text-muted)", border: "none", cursor: "pointer" }}
          >
            {expanded ? "show less" : `+${chips.length - CHIP_LIMIT} more`}
          </button>
        )}
      </div>
    );
  };

  const rowView = (repo: BranchRepo, row: BranchRow, chips: CardSummary[]) => {
    const branchName = (
      <span
        title={
          row.removed ? `${row.branch} (worktree removed)` : row.isMain ? `${row.branch ?? "detached HEAD"} (main checkout)` : (row.branch ?? "detached HEAD")
        }
        style={{
          fontSize: 13,
          fontWeight: row.isMain ? 600 : 500,
          color: row.branch && !row.removed ? "var(--text)" : "var(--text-muted)",
          fontFamily: "var(--font-mono, monospace)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {row.branch ?? "(detached)"}
      </span>
    );
    // A worktree the git trail remembers but that no longer exists: muted, and
    // labelled so it does not read as a live checkout.
    const branch = row.removed ? (
      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {branchName}
        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            padding: "0 5px",
            borderRadius: 4,
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          removed
        </span>
      </span>
    ) : (
      branchName
    );
    const path = <CardPathLabel path={row.cwd} prefix={parentPrefix(repo.repoPath)} color="var(--text-muted)" />;
    return (
      <div
        key={row.cwd}
        data-testid="branch-row"
        data-removed={row.removed || undefined}
        style={{
          padding: "7px 10px",
          borderRadius: 6,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          ...(isMobile
            ? { display: "flex", flexDirection: "column", gap: 4 }
            : {
                display: "grid",
                gridTemplateColumns: "minmax(120px, 220px) minmax(0, 1fr) minmax(140px, 200px) minmax(0, 1.4fr)",
                alignItems: "center",
                gap: 12,
              }),
        }}
      >
        {isMobile ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, justifyContent: "space-between" }}>
              {branch}
              {prBadge(row)}
            </div>
            {path}
            {chipList(row, chips)}
          </>
        ) : (
          <>
            {branch}
            {path}
            <div>{prBadge(row)}</div>
            {chipList(row, chips)}
          </>
        )}
      </div>
    );
  };

  const generatedAt = data ? Date.parse(data.generatedAt) : NaN;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginBottom: 14, fontSize: 12, color: "var(--text-muted)" }}>
        {!Number.isNaN(generatedAt) && <span>updated {formatShortAgo(generatedAt, now, { seconds: true }).toLowerCase()}</span>}
        <button
          aria-label="Refresh branches"
          title="Refresh branches and PRs"
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={() => void load(true)}
          style={{
            display: "flex",
            alignItems: "center",
            padding: "4px 6px",
            borderRadius: 6,
            background: "var(--surface)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            cursor: refreshing ? "default" : "pointer",
          }}
        >
          <RefreshCw size={13} style={{ opacity: refreshing ? 0.5 : 1, animation: refreshing ? "spin 1s linear infinite" : undefined }} />
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", fontSize: 13 }}>
          {error}
        </div>
      )}

      {data === null && !error ? (
        <div style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading branches…</div>
      ) : (
        data !== null && repos.length === 0 && <div style={{ color: "var(--text-muted)", fontSize: 14 }}>No open card is working in a git repository.</div>
      )}

      {repos.map(({ repo, rows }) => (
        <section key={repo.repoPath} aria-label={repo.name} style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span role="heading" aria-level={2} title={repo.repoPath} style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
              {repo.name}
            </span>
            <span style={{ fontSize: 11, color: "var(--board-section-label-text)" }}>{rows.length}</span>
            {repo.prError && (
              <span
                title={`PR data unavailable: ${repo.prError}`}
                aria-label={`PR data unavailable: ${repo.prError}`}
                style={{ display: "flex", color: "var(--warning)" }}
              >
                <AlertTriangle size={13} />
              </span>
            )}
            <span style={{ flex: 1, height: 1, background: "var(--board-group-rule)" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{rows.map(({ row, chips }) => rowView(repo, row, chips))}</div>
        </section>
      ))}
    </div>
  );
}
