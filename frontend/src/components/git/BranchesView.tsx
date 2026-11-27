import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { BranchRepo, BranchRow, CardSummary, GitOverviewResponse } from "../../api";
import { getGitOverview } from "../../api";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useDebouncedCallback } from "../../hooks/useDebouncedCallback";
import { useGitRequest } from "./useGitRequest";
import { formatShortAgo } from "../../utils/dateFormat";
import { ROLLUP_COLORS } from "./rollupColors";
import CardPathLabel from "./CardPathLabel";
import PrBadge from "./PrBadge";

interface BranchesViewProps {
  /**
   * The open cards (conversation trees) the Git page already holds. Rows
   * carry only card ids; titles and status come from here, so this view never
   * refetches cards — and a card the page is not showing (another space) is
   * not shown as a chip either.
   */
  cards: CardSummary[];
  /**
   * False while the page's first card request is still out. The overview is
   * fetched regardless; until the cards arrive there is nothing to join its
   * rows to, which is not the same as there being nothing to show. Default true.
   */
  cardsLoaded?: boolean;
  /**
   * True once a card request of this mount has settled, false while `cards`
   * is only what the page remembered. Remembered cards get their chips at
   * once, but the page is not called empty on their word. Defaults to
   * `cardsLoaded`.
   */
  cardsCurrent?: boolean;
  /**
   * Bumped by the page once it has refetched the cards after a chat or card
   * metadata change: the overview is asked again shortly after. After the
   * cards rather than at the change itself, so the token and whatever the
   * change did to the open cards arrive together and make one request.
   */
  reloadToken?: number;
  /** Called with the card id, which is the conversation's root chat id. */
  onOpenChat: (chatId: string) => void;
}

/** The overview is one request for the whole daemon: nothing keys it. */
const OVERVIEW_CACHE_KEY = "overview";

/** How long after the cards change, or the reload token is bumped, the overview is asked again. */
export const RELOAD_DEBOUNCE_MS = 200;

/** Chips shown on a row before the rest fold behind "+N more". */
const CHIP_LIMIT = 4;

/** Why a repo's PR data is flagged: the listing failed, or only a PR asked about by number did — worded as the chat's PRs tab words it. */
function prErrorLabel(repo: BranchRepo): string {
  return repo.prErrorPartial
    ? `PR data may be incomplete or out of date — a GitHub lookup failed: ${repo.prError}`
    : `PR data unavailable: ${repo.prError}`;
}

/** `parent/` of the repo, so rows read `callboard.feat-x` rather than the whole path. */
function parentPrefix(repoPath: string): string {
  const cut = repoPath.lastIndexOf("/");
  return cut > 0 ? repoPath.slice(0, cut) : "";
}

/**
 * The Git page's branches overview: one row per worktree that unarchived
 * conversations are working in, grouped by repository, with those
 * conversations attached as chips. Read-only — a chip opens its root chat,
 * and archiving lives in the sidebar.
 */
export default function BranchesView({ cards, cardsLoaded = true, cardsCurrent = cardsLoaded, reloadToken = 0, onOpenChat }: BranchesViewProps) {
  const isMobile = useIsMobile();
  const { data, landed, error, refreshing, now, refresh, reload } = useGitRequest<GitOverviewResponse>({
    cacheKey: OVERVIEW_CACHE_KEY,
    fetch: getGitOverview,
    timeoutMessage: "Timed out loading branches — try refreshing.",
    failureMessage: "Failed to load branches",
  });
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());

  // The overview's rows are the worktrees open cards work in, so a change in
  // which cards are open (a chat started in a new worktree, one archived) or
  // in any chat's metadata means the rows may have changed too. Ask again,
  // unforced — the daemon answers that from its PR cache. Debounced, so a
  // burst of changes makes one request.
  const openIds = cards
    .filter((c) => c.lifecycle === "open")
    .map((c) => c.id)
    .sort()
    .join("\n");
  const debouncedReload = useDebouncedCallback(reload, RELOAD_DEBOUNCE_MS);
  // What the overview on screen (or on its way) was asked against. Null until
  // the cards have loaded: their first arrival is not a change, and the
  // mount's own requests cover it.
  const askedFor = useRef<{ openIds: string; reloadToken: number } | null>(null);
  useEffect(() => {
    if (!cardsLoaded) return;
    const previous = askedFor.current;
    askedFor.current = { openIds, reloadToken };
    if (previous && (previous.openIds !== openIds || previous.reloadToken !== reloadToken)) debouncedReload();
  }, [cardsLoaded, openIds, reloadToken, debouncedReload]);

  const openCards = new Map(cards.filter((c) => c.lifecycle === "open").map((c) => [c.id, c]));
  const chipsOf = (row: BranchRow) => row.cardIds.map((id) => openCards.get(id)).filter((c): c is CardSummary => c !== undefined);

  // The daemon only sends worktrees with open cards in them; a row is shown
  // when at least one of those is a card the page shows (not, say, one from
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
            onClick={() => onOpenChat(card.id)}
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
          row.removed ? `${row.branch ?? row.cwd} (worktree removed)` : row.isMain ? `${row.branch ?? "detached HEAD"} (main checkout)` : (row.branch ?? "detached HEAD")
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
        {/* A removed row known only from a PR link has no branch on record: its directory names it. */}
        {row.branch ?? (row.removed ? row.cwd.slice(row.cwd.lastIndexOf("/") + 1) : "(detached)")}
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
  const loadingLine = <div style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading branches…</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginBottom: 14, fontSize: 12, color: "var(--text-muted)" }}>
        {!Number.isNaN(generatedAt) && <span>updated {formatShortAgo(generatedAt, now, { seconds: true }).toLowerCase()}</span>}
        <button
          aria-label="Refresh branches"
          title="Refresh branches and PRs"
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={refresh}
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

      {/* Nothing to show is only an empty page when both halves of the join
          say so now: an overview and a card list that answered during this
          mount. Remembered ones paint what they hold at once, but a chat may
          have started in a repository since, so with nothing to show they are
          still loading. An error stands alone. */}
      {data === null ? (
        !error && loadingLine
      ) : !cardsLoaded ? (
        loadingLine
      ) : repos.length > 0 ? null : landed && cardsCurrent ? (
        <div style={{ color: "var(--text-muted)", fontSize: 14 }}>No active conversation is working in a git repository.</div>
      ) : (
        !error && loadingLine
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
                title={prErrorLabel(repo)}
                aria-label={prErrorLabel(repo)}
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
