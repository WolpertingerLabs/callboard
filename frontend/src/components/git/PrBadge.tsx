import { GitPullRequest } from "lucide-react";
import type { BranchPr, BranchPrState } from "../../api";

const PR_STYLES: Record<BranchPrState, { color: string; background: string }> = {
  open: { color: "var(--success)", background: "var(--success-bg)" },
  draft: { color: "var(--text-muted)", background: "var(--bg-secondary)" },
  merged: { color: "var(--badge-trigger)", background: "color-mix(in srgb, var(--badge-trigger) 15%, transparent)" },
  closed: { color: "var(--danger)", background: "var(--danger-bg)" },
};

/**
 * `#525 open` in the state's colours, linking to the PR — the one badge the
 * Board's Branches view and the chat's PRs tab both draw.
 *
 * Only ever a link to `https://github.com/`: the URL arrives from GitHub's API
 * by way of the daemon, and a badge is no place for anything else to point.
 * Anything else renders the same badge, inert.
 */
export default function PrBadge({ pr }: { pr: BranchPr }) {
  const style: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "1px 7px",
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
    flexShrink: 0,
    textDecoration: "none",
    ...PR_STYLES[pr.state],
  };
  const label = `PR #${pr.number} ${pr.state}: ${pr.title}`;
  const content = (
    <>
      <GitPullRequest size={11} />#{pr.number} {pr.state}
    </>
  );
  if (!pr.url.startsWith("https://github.com/")) {
    return (
      <span title={pr.title} aria-label={label} style={style}>
        {content}
      </span>
    );
  }
  return (
    <a href={pr.url} target="_blank" rel="noreferrer" title={pr.title} aria-label={label} style={style}>
      {content}
    </a>
  );
}
