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
 * The chat's git trail (`metadata.gitTrail`, see git-trail.ts) adds the PRs
 * of branches its folder was on earlier, deleted worktrees included. Those
 * are matched by branch name alone — the chat demonstrably worked there — while
 * the live branch keeps the overview's SHA rule, so everything shown without a
 * trail is still shown with one.
 */
import { basename } from "path";
import type { Chat, ChatPr, ChatPrsResponse, FolderPrs, GitTrailEntry } from "shared";
import { createCardContext } from "./card-context.js";
import { chatFileService } from "./chat-file-service.js";
import { listChatsSnapshot } from "./chats-snapshot.js";
import { DEFAULT_PLACEMENT_DEPS, placeFolders, type FolderPlacement, type PlacementDeps } from "./git-overview.js";
import { parseGitTrail } from "./git-trail.js";
import { requestBackfill, type BackfillRequest } from "./git-trail-backfill.js";
import { getRepoPulls, matchPull, pullForTrailBranch, toChatPr, type RepoPulls } from "./github-prs.js";
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
  const direct = chatFileService.getChatBySessionId(chatId);
  if (direct && (direct.id === chatId || direct.session_id === chatId)) return trailOfRecord(direct.metadata);
  return trailOfRecord(snapshot().find((chat) => chat.id === chatId)?.metadata);
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

/** A placement's live (cwd, branch), for skipping the trail entry that repeats it. */
const liveKey = (placement: FolderPlacement | undefined) =>
  placement?.kind === "placed" ? `${placement.worktree.normPath}\0${placement.worktree.branch}` : null;
const entryKey = (entry: GitTrailEntry) => `${entry.cwd}\0${entry.branch}`;

/**
 * Assemble the PRs tab for `folder` (the chat's directory) and, given a
 * `chatId`, its trail and its card. `force` is the refresh button, with the
 * forced-refresh semantics of {@link getRepoPulls}.
 */
export async function buildChatPrs(opts: { folder: string; chatId?: string; force?: boolean }, deps: ChatPrsDeps = defaultDeps()): Promise<ChatPrsResponse> {
  const card = opts.chatId ? deps.cardOf(opts.chatId) : null;
  const ownTrail = opts.chatId && deps.trailOf ? deps.trailOf(opts.chatId) : [];
  const placements = await placeFolders(new Set([opts.folder, ...(card?.members.map((m) => m.folder) ?? [])]), deps);

  const current = placements.get(opts.folder);
  const currentCwd = current?.kind === "placed" ? current.worktree.normPath : deps.normalize(opts.folder);

  // Members working in a directory other than this chat's — the only ones
  // whose live PRs could differ from the one above.
  const elsewhere = (card?.members ?? []).flatMap((member) => {
    const placement = placements.get(member.folder);
    return placement?.kind === "placed" && placement.worktree.normPath !== currentCwd ? [{ member, placement }] : [];
  });

  // Trail entries worth a lookup: their repository still exists, and they are
  // not the very (cwd, branch) the live lookup already answers for that chat.
  const usableTrail = (trail: GitTrailEntry[] | undefined, live: FolderPlacement | undefined) =>
    (trail ?? []).filter((entry) => entryKey(entry) !== liveKey(live) && deps.exists(entry.repoPath));
  const ownEntries = usableTrail(ownTrail, current);
  const memberEntries = (card?.members ?? []).map((member) => ({ member, entries: usableTrail(member.trail, placements.get(member.folder)) }));

  // One lookup per repository, shared by every directory and trail entry in it.
  const repoPaths = new Set<string>();
  if (current?.kind === "placed") repoPaths.add(current.repo.repoPath);
  for (const { placement } of elsewhere) repoPaths.add(placement.repo.repoPath);
  for (const entry of ownEntries) repoPaths.add(entry.repoPath);
  for (const { entries } of memberEntries) for (const entry of entries) repoPaths.add(entry.repoPath);
  // Chats that predate the live trail get theirs from their history, once, in
  // the background — never awaited here. The repositories already in view
  // help it match a Codex rollout's repository_url.
  if (opts.chatId && deps.requestBackfill) {
    const knownRepos = [...repoPaths];
    // The chat on screen goes ahead of the Board's backlog.
    deps.requestBackfill({ chatId: opts.chatId, knownRepos, priority: true });
    for (const member of card?.members ?? []) if (member.chatId !== opts.chatId) deps.requestBackfill({ chatId: member.chatId, knownRepos });
  }
  const pullsByRepo = new Map<string, RepoPulls>();
  await Promise.all([...repoPaths].map(async (repoPath) => pullsByRepo.set(repoPath, await deps.pullsFor(repoPath, opts.force === true))));

  const currentPrs = folderPrs(opts.folder, current, current?.kind === "placed" ? pullsByRepo.get(current.repo.repoPath) : undefined);

  // One list, one entry per URL: this chat's live PR and its trail's, then
  // the card's other chats' live PRs and their trails.
  const byUrl = new Map<string, ChatPr>();
  const add = (pr: ChatPr | undefined) => {
    if (pr && !byUrl.has(pr.url)) byUrl.set(pr.url, pr);
  };
  const addTrail = (entries: GitTrailEntry[]) => {
    for (const entry of entries) {
      const pull = pullForTrailBranch(pullsByRepo.get(entry.repoPath), entry.branch);
      if (pull) add(toChatPr(pull));
    }
  };
  add(currentPrs.pr);
  addTrail(ownEntries);
  for (const { member, placement } of elsewhere) add(folderPrs(member.folder, placement, pullsByRepo.get(placement.repo.repoPath)).pr);
  for (const { entries } of memberEntries) addTrail(entries);

  return { current: currentPrs, prs: [...byUrl.values()].sort(byOpenThenUpdated), generatedAt: new Date().toISOString() };
}
