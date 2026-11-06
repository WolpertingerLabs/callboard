/**
 * The PRs tab of a chat's git view: the pull request of the chat's own
 * directory, and those of the other directories its card's chats work in.
 *
 * "Which PR does this directory's branch have" is a question about the
 * directory, so it is answered per `cwd` through exactly the path the Board's
 * Branches view uses — {@link placeFolders} for directory → worktree → branch
 * and HEAD, {@link getRepoPulls} for the cached, stale-while-revalidate PR
 * listing and {@link matchPull} for the match. Card membership only decides
 * which directories are asked about (see "Workspace keying" in .claude/CLAUDE.md).
 */
import { basename } from "path";
import type { CardPr, CardPrSource, ChatPrsResponse, FolderPrs } from "shared";
import { createCardContext } from "./card-context.js";
import { DEFAULT_PLACEMENT_DEPS, placeFolders, type FolderPlacement, type PlacementDeps } from "./git-overview.js";
import { getRepoPulls, matchPull, toChatPr, type RepoPulls } from "./github-prs.js";

/** The card a chat is on, with its member chats' directories. */
export interface ChatCard {
  cardId: string;
  title: string;
  members: CardPrSource[];
}

/**
 * The card `chatId` belongs to, or null when it is on none.
 *
 * Through the card context — the stat-gated chat snapshot the board's rollup
 * reads — not `getChat`, whose miss path scans every record, and projecting
 * members for this one card only. Hidden and archived cards count: the chat
 * is still on them.
 */
export function cardOfChat(chatId: string): ChatCard | null {
  const context = createCardContext();
  const resolved = context.resolve(chatId);
  if (!resolved) return null;
  const [card] = context.summaries([], true, resolved.rootChatId);
  if (!card) return null;
  return {
    cardId: card.id,
    title: card.title,
    members: card.memberChats.filter((m) => m.folder).map((m) => ({ chatId: m.chatId, title: m.title, folder: m.folder })),
  };
}

export interface ChatPrsDeps extends PlacementDeps {
  pullsFor: (repoPath: string, force: boolean) => Promise<RepoPulls>;
  cardOf: (chatId: string) => ChatCard | null;
}

const DEFAULT_DEPS: ChatPrsDeps = { ...DEFAULT_PLACEMENT_DEPS, pullsFor: getRepoPulls, cardOf: cardOfChat };

/** One directory's PR, or the reason it has none. */
function folderPrs(folder: string, placement: FolderPlacement | undefined, pulls: RepoPulls | undefined): FolderPrs {
  if (!placement || placement.kind === "not_git") return { folder, status: "not_git" };
  if (placement.kind === "no_verdict") return { folder, status: "error", prError: "git did not answer in time" };
  const { repo, worktree } = placement;
  const base = { folder, cwd: worktree.normPath, repoName: basename(repo.repoPath), branch: worktree.branch };
  if (!pulls?.github) return { ...base, status: "not_github" };
  if (worktree.branch === null) return { ...base, status: "detached" };
  if (worktree.branch === pulls.defaultBranch) return { ...base, status: "default_branch" };
  const pr = matchPull(pulls.byBranch.get(worktree.branch), worktree.head);
  const prError = pulls.error !== undefined ? { prError: pulls.error } : {};
  if (pr) return { ...base, status: "found", pr: toChatPr(pr), ...prError };
  if (pulls.error !== undefined) return { ...base, status: "error", ...prError };
  return { ...base, status: "no_pr" };
}

/**
 * Assemble the PRs tab for `folder` (the chat's directory) and, given a
 * `chatId`, its card. `force` is the refresh button, with the forced-refresh
 * semantics of {@link getRepoPulls}.
 */
export async function buildChatPrs(opts: { folder: string; chatId?: string; force?: boolean }, deps: ChatPrsDeps = DEFAULT_DEPS): Promise<ChatPrsResponse> {
  const card = opts.chatId ? deps.cardOf(opts.chatId) : null;
  const placements = await placeFolders(new Set([opts.folder, ...(card?.members.map((m) => m.folder) ?? [])]), deps);

  const current = placements.get(opts.folder);
  const currentCwd = current?.kind === "placed" ? current.worktree.normPath : deps.normalize(opts.folder);

  // Members working in a directory other than this chat's — the only ones
  // whose PRs could differ from the one above.
  const elsewhere = (card?.members ?? []).flatMap((member) => {
    const placement = placements.get(member.folder);
    return placement?.kind === "placed" && placement.worktree.normPath !== currentCwd ? [{ member, placement }] : [];
  });

  // One lookup per repository, shared by every directory in it.
  const repoPaths = new Set<string>();
  if (current?.kind === "placed") repoPaths.add(current.repo.repoPath);
  for (const { placement } of elsewhere) repoPaths.add(placement.repo.repoPath);
  const pullsByRepo = new Map<string, RepoPulls>();
  await Promise.all([...repoPaths].map(async (repoPath) => pullsByRepo.set(repoPath, await deps.pullsFor(repoPath, opts.force === true))));

  const currentPrs = folderPrs(opts.folder, current, current?.kind === "placed" ? pullsByRepo.get(current.repo.repoPath) : undefined);

  let cardSection: ChatPrsResponse["card"];
  if (card && elsewhere.length > 0) {
    // Deduplicated by URL — PR numbers are only unique within a repository —
    // and never repeating the PR already shown for this chat's directory.
    const byUrl = new Map<string, CardPr>();
    for (const { member, placement } of elsewhere) {
      const found = folderPrs(member.folder, placement, pullsByRepo.get(placement.repo.repoPath));
      if (!found.pr || found.pr.url === currentPrs.pr?.url) continue;
      const entry = byUrl.get(found.pr.url) ?? { pr: found.pr, repoName: found.repoName!, branch: found.branch!, sources: [] };
      entry.sources.push(member);
      byUrl.set(found.pr.url, entry);
    }
    // Open work first, then most recently updated.
    const open = (pr: CardPr) => Number(pr.pr.state === "open" || pr.pr.state === "draft");
    const prs = [...byUrl.values()].sort((a, b) => open(b) - open(a) || b.pr.updatedAt.localeCompare(a.pr.updatedAt));
    cardSection = { cardId: card.cardId, title: card.title, prs };
  }

  return { current: currentPrs, ...(cardSection && { card: cardSection }), generatedAt: new Date().toISOString() };
}
