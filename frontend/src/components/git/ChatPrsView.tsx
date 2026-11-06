import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, GitBranch, GitPullRequest, RefreshCw } from "lucide-react";
import type { CardPrSource, ChatPr, ChatPrsResponse, FolderPrs } from "../../api";
import { getChatPrs } from "../../api";
import { usePolling } from "../../hooks/usePolling";
import { errorMessage } from "../../utils/errorMessage";
import { formatShortAgo } from "../../utils/dateFormat";
import PrBadge from "./PrBadge";

interface ChatPrsViewProps {
  /** The chat's directory — the PR shown first is this directory's branch's. */
  folder: string;
  /** Absent for a chat not yet created: then only the folder's PR is shown. */
  chatId?: string;
}

/** Why a directory has no PR, in words. `found` never reaches here. */
function emptyMessage(current: FolderPrs): string {
  switch (current.status) {
    case "not_git":
      return "This folder is not in a git repository.";
    case "not_github":
      return "This repository's origin is not on GitHub, so there are no PRs to look up.";
    case "detached":
      return "No branch is checked out here (detached HEAD).";
    case "default_branch":
      return `This is ${current.branch}, the default branch — work here has no PR of its own.`;
    case "error":
      return `Couldn't look up PRs: ${current.prError ?? "unknown error"}`;
    default:
      return `No PR found for ${current.branch ?? "this branch"}.`;
  }
}

const ago = (iso: string | undefined, now: number) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : formatShortAgo(ms, now).toLowerCase();
};

/** Source chats listed under a card PR before the rest fold behind "and N more". */
const SOURCE_LIMIT = 3;

const sectionLabel: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "var(--board-section-label-text)",
  textTransform: "uppercase",
  letterSpacing: 0.6,
  marginBottom: 8,
};

const panel: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  background: "var(--surface)",
  border: "1px solid var(--border)",
};

/**
 * The PRs half of a chat's git view: the PR of the branch checked out in the
 * chat's directory, then the PRs the card's other chats are working on.
 * Fetched when shown, polled slowly while it stays shown; read-only.
 */
export default function ChatPrsView({ folder, chatId }: ChatPrsViewProps) {
  const [data, setData] = useState<ChatPrsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Only the newest request may land: a slow poll must not overwrite a refresh,
  // nor a previous chat's answer a new one's.
  const seq = useRef(0);
  // Card PRs (by URL) whose source-chat list the user has expanded.
  const [expandedSources, setExpandedSources] = useState<Set<string>>(() => new Set());

  const load = useCallback(
    async (refresh = false) => {
      const mine = ++seq.current;
      if (refresh) setRefreshing(true);
      try {
        const res = await getChatPrs(folder, chatId, refresh);
        if (mine !== seq.current) return;
        setData(res);
        setError(null);
      } catch (err) {
        if (mine !== seq.current) return;
        setError(errorMessage(err, "Failed to load PRs"));
      } finally {
        if (mine === seq.current) setRefreshing(false);
        setNow(Date.now());
      }
    },
    [folder, chatId],
  );

  // A different chat or folder remounts this view (ChatGitView keys it), so
  // there is no previous answer to clear here.
  useEffect(() => {
    void load();
  }, [load]);

  // PRs move slowly; the refresh button covers the impatient. usePolling skips
  // ticks while the document is hidden, and this component is only mounted
  // while the PRs tab is the one showing.
  usePolling(() => load(), 60_000);
  usePolling(() => setNow(Date.now()), 10_000, { catchUp: false });

  const prCard = (pr: ChatPr, sources?: CardPrSource[], context?: { repoName: string }) => {
    const opened = ago(pr.createdAt, now);
    const updated = ago(pr.updatedAt, now);
    const merged = ago(pr.mergedAt, now);
    const closed = pr.state === "closed" ? ago(pr.closedAt, now) : null;
    const linkable = pr.url.startsWith("https://github.com/");
    return (
      <div key={pr.url} data-testid="pr-card" style={{ ...panel, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
          <PrBadge pr={pr} />
          {linkable ? (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", textDecoration: "none", minWidth: 0, overflowWrap: "anywhere" }}
            >
              {pr.title}
            </a>
          ) : (
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", minWidth: 0, overflowWrap: "anywhere" }}>{pr.title}</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12, color: "var(--text-muted)" }}>
          <GitBranch size={12} />
          <span style={{ fontFamily: "var(--font-mono, monospace)", overflowWrap: "anywhere" }}>
            {pr.headRef} → {pr.baseRef}
          </span>
          {context && <span>· {context.repoName}</span>}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: "var(--text-muted)" }}>
          {pr.author && <span>by {pr.author}</span>}
          {opened && <span>opened {opened}</span>}
          {merged ? <span>merged {merged}</span> : closed ? <span>closed {closed}</span> : updated && <span>updated {updated}</span>}
        </div>
        {sources && sources.length > 0 && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              fontSize: 12,
              color: "var(--text-muted)",
              borderTop: "1px solid var(--border)",
              paddingTop: 6,
            }}
          >
            {(expandedSources.has(pr.url) ? sources : sources.slice(0, SOURCE_LIMIT)).map((source) => (
              <div key={source.chatId} title={source.folder} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <span style={{ color: "var(--text)" }}>{source.title ?? "Untitled chat"}</span> · {source.folder}
              </div>
            ))}
            {sources.length > SOURCE_LIMIT && (
              <button
                aria-expanded={expandedSources.has(pr.url)}
                onClick={() =>
                  setExpandedSources((prev) => {
                    const next = new Set(prev);
                    if (next.has(pr.url)) next.delete(pr.url);
                    else next.add(pr.url);
                    return next;
                  })
                }
                style={{
                  alignSelf: "flex-start",
                  padding: 0,
                  fontSize: 12,
                  background: "transparent",
                  color: "var(--accent-text)",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {expandedSources.has(pr.url) ? "show fewer" : `and ${sources.length - SOURCE_LIMIT} more`}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const generatedAt = data ? Date.parse(data.generatedAt) : NaN;
  const current = data?.current;
  // The chat's own PRs: the live one and its trail's. A daemon predating the
  // trail sends only `pr`.
  const ownPrs = current?.prs ?? (current?.pr ? [current.pr] : []);

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "12px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginBottom: 12, fontSize: 12, color: "var(--text-muted)" }}>
        {!Number.isNaN(generatedAt) && <span>updated {formatShortAgo(generatedAt, now, { seconds: true }).toLowerCase()}</span>}
        <button
          aria-label="Refresh PRs"
          title="Refresh PRs"
          disabled={refreshing}
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
          <RefreshCw size={13} style={{ opacity: refreshing ? 0.5 : 1 }} />
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", fontSize: 13 }}>
          {error}
        </div>
      )}

      {!data && !error && <div style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading PRs…</div>}

      {current && (
        <section aria-label="This chat" style={{ marginBottom: 24 }}>
          <div role="heading" aria-level={2} style={sectionLabel}>
            This chat
          </div>
          {ownPrs.length > 0 ? (
            <>
              {/* The live branch has no PR of its own (the default branch, say)
                  but the chat's earlier branches do: say why compactly, then
                  list them. */}
              {!current.pr && (
                <div
                  data-testid="pr-status-line"
                  data-status={current.status}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 8,
                    fontSize: 12,
                    color: current.status === "error" ? "var(--warning)" : "var(--text-muted)",
                  }}
                >
                  {current.status === "error" ? <AlertTriangle size={12} /> : <GitPullRequest size={12} />}
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{emptyMessage(current)}</span>
                </div>
              )}
              {/* One list — the live PR and the chat's earlier ones — open first,
                  then most recently updated; the state badge tells them apart. */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{ownPrs.map((pr) => prCard(pr))}</div>
              {current.pr && current.prError && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 12, color: "var(--warning)" }}>
                  <AlertTriangle size={12} />
                  Last known PR — refreshing failed: {current.prError}
                </div>
              )}
            </>
          ) : (
            <div
              data-testid="pr-empty"
              data-status={current.status}
              style={{
                ...panel,
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                color: current.status === "error" ? "var(--warning)" : "var(--text-muted)",
              }}
            >
              {current.status === "error" ? <AlertTriangle size={14} /> : <GitPullRequest size={14} />}
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{emptyMessage(current)}</span>
            </div>
          )}
        </section>
      )}

      {data?.card && (
        <section aria-label="Other chats on this card">
          <div role="heading" aria-level={2} style={sectionLabel}>
            Other chats on this card
          </div>
          {data.card.prs.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{"No PRs for the card's other chats."}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {data.card.prs.map((entry) => prCard(entry.pr, entry.sources, { repoName: entry.repoName }))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
