import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, GitBranch, GitPullRequest, RefreshCw } from "lucide-react";
import type { ChatPr, ChatPrsResponse, FolderPrs } from "../../api";
import { getChatPrs } from "../../api";
import { usePolling } from "../../hooks/usePolling";
import { errorMessage } from "../../utils/errorMessage";
import { formatShortAgo } from "../../utils/dateFormat";
import PrBadge from "./PrBadge";

interface ChatPrsViewProps {
  /** The chat's directory — its live branch is the status line's subject. */
  folder: string;
  /** Absent for a chat not yet created: then only the folder's PRs are shown. */
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

const panel: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  background: "var(--surface)",
  border: "1px solid var(--border)",
};

/**
 * The PRs half of a chat's git view: one list of every PR the chat and its
 * card's other chats have worked on, as the daemon orders it (open first, then
 * most recently updated), with the chat's own live branch's status above it
 * when that branch has no PR of its own. Fetched when shown, polled slowly
 * while it stays shown; read-only.
 */
export default function ChatPrsView({ folder, chatId }: ChatPrsViewProps) {
  const [data, setData] = useState<ChatPrsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Only the newest request may land: a slow poll must not overwrite a refresh,
  // nor a previous chat's answer a new one's.
  const seq = useRef(0);

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

  const prCard = (pr: ChatPr) => {
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
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: "var(--text-muted)" }}>
          {pr.author && <span>by {pr.author}</span>}
          {opened && <span>opened {opened}</span>}
          {merged ? <span>merged {merged}</span> : closed ? <span>closed {closed}</span> : updated && <span>updated {updated}</span>}
        </div>
      </div>
    );
  };

  const generatedAt = data ? Date.parse(data.generatedAt) : NaN;
  const current = data?.current;
  const prs = data?.prs ?? [];

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

      {current &&
        (prs.length > 0 ? (
          <>
            {/* The live branch has no PR of its own (the default branch, say)
                but the list does: say why compactly, then list them. */}
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
            {/* One list, one card per PR; the state badge tells them apart. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{prs.map((pr) => prCard(pr))}</div>
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
        ))}
    </div>
  );
}
