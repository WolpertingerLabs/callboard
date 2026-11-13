/**
 * The PRs tab of a chat's git view: one list of every pull request the chat
 * and its card's other chats have worked on — their live branches and their
 * git trails — one entry per URL, open first, then most recently updated,
 * beside the status of the chat's own live branch.
 *
 * "Which PR does this directory's branch have" is a question about the
 * directory, so it is answered per `cwd` through exactly the path the Board's
 * Branches view uses — {@link placeFolders} for directory → worktree → branch
 * and HEAD, {@link getRepoPulls} for the cached, stale-while-revalidate PR
 * listing and {@link matchPull} for the match. Card membership only decides
 * which directories are asked about (see "Workspace keying" in .claude/CLAUDE.md).
 *
 * Two records of what the chats themselves did add to that, and are what
 * makes the list complete:
 *
 *  - PR links (`metadata.prLinks`, see chat-pr-links.ts): the PRs each chat's
 *    transcript names, by number. Synced from the transcripts before this
 *    answers, so every PR the card's chats made is in the first response.
 *  - The git trail (`metadata.gitTrail`, see git-trail.ts): the branches each
 *    chat's folder was on, deleted worktrees included, matched by branch name
 *    and time ({@link pullsForTrailEntry}) — the live branch too, so a PR
 *    whose branch has moved on since it merged is still found.
 *
 * The live branch's SHA rule ({@link matchPull}) remains for a folder with no
 * chat behind it, and nothing it finds is lost.
 */
import { homedir } from "os";
import { basename } from "path";
import type { Chat, ChatPr, ChatPrLink, ChatPrsResponse, FolderPrs, GitTrailEntry } from "shared";
import { createCardContext } from "./card-context.js";
import { chatFileService } from "./chat-file-service.js";
import { syncChatPrLinks } from "./chat-pr-links.js";
import { listChatsSnapshot } from "./chats-snapshot.js";
import { DEFAULT_PLACEMENT_DEPS, placeFolders, type FolderPlacement, type PlacementDeps } from "./git-overview.js";
import { parseGitTrail } from "./git-trail.js";
import { requestBackfill, type BackfillRequest } from "./git-trail-backfill.js";
import {
  getRepoPulls,
  isLinkOf,
  matchPull,
  pullsForTrailEntry,
  recordedPullForBranch,
  resolveLinkedPulls,
  toChatPr,
  type LinkedPulls,
  type PullSummary,
  type RepoPulls,
} from "./github-prs.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";

/** A member chat of a card: its directory and its recorded git trail. */
export interface ChatCardMember {
  chatId: string;
  folder: string;
  trail?: GitTrailEntry[];
}

/** The card a chat is on, as the PRs tab needs it: its member chats. */
export interface ChatCard {
  members: ChatCardMember[];
}

const trailOfRecord = (metadata: string | null | undefined): GitTrailEntry[] => parseGitTrail(parseChatMetadata(metadata).gitTrail);

/**
 * The card `chatId` belongs to, or null when it is on none.
 *
 * Through the card context — the stat-gated chat snapshot the board's rollup
 * reads — not `getChat`, whose miss path scans every record, and projecting
 * members for this one card only. Hidden and archived cards count: the chat
 * is still on them. Members' trails come from the same snapshot.
 */
export function cardOfChat(chatId: string, stored: Chat[] = listChatsSnapshot()): ChatCard | null {
  const context = createCardContext(stored);
  const resolved = context.resolve(chatId);
  if (!resolved) return null;
  const [card] = context.summaries([], true, resolved.rootChatId);
  if (!card) return null;
  const byId = new Map(stored.map((chat) => [chat.id, chat]));
  return {
    members: card.memberChats
      .filter((m) => m.folder)
      .map((m) => ({ chatId: m.chatId, folder: m.folder, trail: trailOfRecord(byId.get(m.chatId)?.metadata) })),
  };
}

/**
 * Chat `chatId`'s own git trail: one file read when the record is filed under
 * that id, else from the snapshot — never `getChat`'s scan of every record,
 * which this route would otherwise pay on every poll of the PRs tab.
 */
export function trailOfChat(chatId: string, snapshot: () => Chat[] = listChatsSnapshot): GitTrailEntry[] {
  return trailOfRecord(recordOfChat(chatId, snapshot)?.metadata);
}

/** Chat `chatId`'s record: its own file when filed under that id, else the snapshot's. */
function recordOfChat(chatId: string, snapshot: () => Chat[]): Chat | undefined {
  const direct = chatFileService.getChatBySessionId(chatId);
  if (direct && (direct.id === chatId || direct.session_id === chatId)) return direct;
  return snapshot().find((chat) => chat.id === chatId);
}

export interface ChatPrsDeps extends PlacementDeps {
  pullsFor: (repoPath: string, force: boolean) => Promise<RepoPulls>;
  cardOf: (chatId: string) => ChatCard | null;
  /** Defaults to no trail, so callers predating the trail see today's answer. */
  trailOf?: (chatId: string) => GitTrailEntry[];
  /**
   * Queue a one-time history backfill of a chat's trail. Must return at once:
   * this response answers from the trail as it is, the next poll sees more.
   */
  requestBackfill?: (request: BackfillRequest) => void;
  /** The PRs a chat's history names, brought up to date first. Defaults to none. */
  linksOf?: (chatId: string) => Promise<ChatPrLink[]>;
  /** The PR behind each link, in order; see {@link resolveLinkedPulls}. */
  linkedPulls?: (links: ChatPrLink[], known: RepoPulls[], force: boolean) => Promise<LinkedPulls>;
}

/** Production deps: the card and the trail share one chat snapshot per request, taken only if needed. */
function defaultDeps(): ChatPrsDeps {
  let stored: Chat[] | undefined;
  const snapshot = () => (stored ??= listChatsSnapshot());
  return {
    ...DEFAULT_PLACEMENT_DEPS,
    pullsFor: getRepoPulls,
    cardOf: (chatId) => cardOfChat(chatId, snapshot()),
    trailOf: (chatId) => trailOfChat(chatId, snapshot),
    requestBackfill: (request) => requestBackfill(request),
    linksOf: async (chatId) => {
      const record = recordOfChat(chatId, snapshot);
      return record ? syncChatPrLinks(record) : [];
    },
    linkedPulls: (links, known, force) => resolveLinkedPulls(links, known, { cwd: homedir(), force }),
  };
}

/** One directory's PR, or the reason it has none. */
function folderPrs(folder: string, placement: FolderPlacement | undefined, pulls: RepoPulls | undefined): FolderPrs {
  if (!placement || placement.kind === "not_git") return { folder, status: "not_git" };
  if (placement.kind === "no_verdict") return { folder, status: "error", prError: "git did not answer in time" };
  const { repo, worktree } = placement;
  const base = { folder, cwd: worktree.normPath, repoName: basename(repo.repoPath), branch: worktree.branch };
  if (!pulls?.github) return { ...base, status: "not_github" };
  if (worktree.branch === null) return { ...base, status: "detached" };
  // Unknown default branch (no PRs in the listing, no local origin/HEAD) means
  // the default branch reads as "No PR found for <branch>" — a fair answer.
  if (worktree.branch === pulls.defaultBranch) return { ...base, status: "default_branch" };
  const pr = matchPull(pulls.byBranch.get(worktree.branch), worktree.head);
  const prError = pulls.error !== undefined ? { prError: pulls.error } : {};
  if (pr) return { ...base, status: "found", pr: toChatPr(pr), ...prError };
  if (pulls.error !== undefined) return { ...base, status: "error", ...prError };
  return { ...base, status: "no_pr" };
}

const isOpen = (pr: ChatPr) => pr.state === "open" || pr.state === "draft";
/** Open work first, then most recently updated. */
const byOpenThenUpdated = (a: ChatPr, b: ChatPr) => Number(isOpen(b)) - Number(isOpen(a)) || b.updatedAt.localeCompare(a.updatedAt);

/**
 * Assemble the PRs tab for `folder` (the chat's directory) and, given a
 * `chatId`, its trail and its card. `force` is the refresh button, with the
 * forced-refresh semantics of {@link getRepoPulls}.
 */
export async function buildChatPrs(opts: { folder: string; chatId?: string; force?: boolean }, deps: ChatPrsDeps = defaultDeps()): Promise<ChatPrsResponse> {
  const force = opts.force === true;
  const card = opts.chatId ? deps.cardOf(opts.chatId) : null;
  const ownTrail = opts.chatId && deps.trailOf ? deps.trailOf(opts.chatId) : [];
  const others = (card?.members ?? []).filter((member) => member.chatId !== opts.chatId);
  const chatIds = opts.chatId ? [opts.chatId, ...others.map((member) => member.chatId)] : [];

  // Local work first, all at once: where each directory is, and what each
  // chat's transcript says it made.
  const [placements, linkLists] = await Promise.all([
    placeFolders(new Set([opts.folder, ...(card?.members.map((m) => m.folder) ?? [])]), deps),
    Promise.all(chatIds.map((chatId) => deps.linksOf?.(chatId) ?? [])),
  ]);

  const current = placements.get(opts.folder);
  const currentCwd = current?.kind === "placed" ? current.worktree.normPath : deps.normalize(opts.folder);

  // Members working in a directory other than this chat's — the only ones
  // whose live PRs could differ from the one above.
  const elsewhere = others.flatMap((member) => {
    const placement = placements.get(member.folder);
    return placement?.kind === "placed" && placement.worktree.normPath !== currentCwd ? [{ member, placement }] : [];
  });

  // Trail entries worth a lookup: those whose repository still exists.
  const usable = (trail: GitTrailEntry[] | undefined) => (trail ?? []).filter((entry) => deps.exists(entry.repoPath));
  const ownEntries = usable(ownTrail);
  const memberEntries = others.flatMap((member) => usable(member.trail));

  // One lookup per repository, shared by every directory and trail entry in it.
  const repoPaths = new Set<string>();
  if (current?.kind === "placed") repoPaths.add(current.repo.repoPath);
  for (const { placement } of elsewhere) repoPaths.add(placement.repo.repoPath);
  for (const entry of [...ownEntries, ...memberEntries]) repoPaths.add(entry.repoPath);
  // Chats that predate the live trail get theirs from their history, once, in
  // the background — never awaited here. The repositories already in view
  // help it match a Codex rollout's repository_url. The card on screen goes
  // ahead of the Board's backlog, the chat itself (requested last) first.
  if (opts.chatId && deps.requestBackfill) {
    const knownRepos = [...repoPaths];
    for (const member of others) deps.requestBackfill({ chatId: member.chatId, knownRepos, priority: true });
    deps.requestBackfill({ chatId: opts.chatId, knownRepos, priority: true });
  }
  const pullsByRepo = new Map<string, RepoPulls>();
  await Promise.all([...repoPaths].map(async (repoPath) => pullsByRepo.set(repoPath, await deps.pullsFor(repoPath, force))));

  // The linked PRs, from those listings where they hold them.
  const links = linkLists.flat();
  const linked: LinkedPulls = links.length > 0 && deps.linkedPulls ? await deps.linkedPulls(links, [...pullsByRepo.values()], force) : { pulls: [] };
  /** Chat `index`'s links with the PR behind each, less those GitHub does not have. */
  const linksOf = (index: number) => {
    const start = linkLists.slice(0, index).reduce((n, list) => n + list.length, 0);
    return linkLists[index].flatMap((link, i) => {
      const pr = linked.pulls[start + i];
      return pr ? [{ link, pr }] : [];
    });
  };
  const linkedOf = (index: number) => linksOf(index).map(({ pr }) => pr);

  let currentPrs = folderPrs(opts.folder, current, current?.kind === "placed" ? pullsByRepo.get(current.repo.repoPath) : undefined);

  // One list, one entry per URL: this chat's live PR, links and trail, then
  // the card's other chats' live PRs, links and trails.
  // Compared in lower case: an `unknown` PR's URL is spelled as the
  // transcript spelled the repository, a listed one's as GitHub does.
  const byUrl = new Map<string, ChatPr>();
  const add = (pr: PullSummary | ChatPr | undefined) => {
    if (!pr) return;
    const key = pr.url.toLowerCase();
    // A link GitHub could not be asked about gives way to the PR itself,
    // whichever is met first.
    const known = byUrl.get(key);
    if (!known || (known.state === "unknown" && pr.state !== "unknown")) byUrl.set(key, "headSha" in pr ? toChatPr(pr) : pr);
  };
  const trailPulls = (entries: GitTrailEntry[]) => entries.flatMap((entry) => pullsForTrailEntry(pullsByRepo.get(entry.repoPath), entry));

  // The live branch's PR, when the SHA rule found none but the chat's own
  // record did — chosen as the Board chooses it.
  if (currentPrs.status === "no_pr" && current?.kind === "placed") {
    const here = pullsByRepo.get(current.repo.repoPath);
    const ownLinked = opts.chatId ? linksOf(0).flatMap(({ link, pr }) => (isLinkOf(link, pr, here?.github) ? [pr] : [])) : [];
    const own = [...trailPulls(ownEntries.filter((entry) => entry.cwd === currentCwd)), ...ownLinked];
    const pr = recordedPullForBranch(own, current.worktree.branch, here);
    if (pr) currentPrs = { ...currentPrs, status: "found", pr: toChatPr(pr) };
  }

  add(currentPrs.pr);
  if (opts.chatId) for (const pr of linkedOf(0)) add(pr);
  for (const pr of trailPulls(ownEntries)) add(pr);
  for (const { member, placement } of elsewhere) add(folderPrs(member.folder, placement, pullsByRepo.get(placement.repo.repoPath)).pr);
  others.forEach((_, i) => {
    for (const pr of linkedOf(i + 1)) add(pr);
  });
  for (const pr of trailPulls(memberEntries)) add(pr);

  // A failed lookup by number is reported like a failed listing — beside the
  // PRs that are known, never instead of them.
  if (linked.error !== undefined && currentPrs.prError === undefined && currentPrs.status !== "error") currentPrs = { ...currentPrs, prError: linked.error };

  return { current: currentPrs, prs: [...byUrl.values()].sort(byOpenThenUpdated), generatedAt: new Date().toISOString() };
}
