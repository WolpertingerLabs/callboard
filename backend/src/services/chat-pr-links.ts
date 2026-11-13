/**
 * The pull requests a chat's own history names: `metadata.prLinks`.
 *
 * Claude Code writes a `pr-link` entry — `{ type: "pr-link", prNumber,
 * prUrl, prRepository, timestamp }` — to a session's transcript whenever the
 * session creates or works on a PR. That is local, structured evidence of
 * exactly which PRs a chat touched, however many branches it went through
 * inside one turn and whatever has since happened to them: no branch-name
 * match, no SHA rule, no GitHub call. The git trail (git-trail.ts) stays as
 * the answer for engines and transcripts that carry no such entries.
 *
 * Incremental and cheap: a transcript is append-only, so each session's scan
 * resumes at the byte it stopped at (`metadata.prLinkScan`, by session id).
 * An up-to-date chat costs one `stat` per session; a grown one, a read of
 * what was appended — a byte search for the entry's marker, parsing only the
 * lines that carry it. Run at every turn's end and, awaited, when the PRs tab
 * asks about a card, so the tab's first answer is already complete.
 *
 * Failures never reach a turn or a request: a chat that cannot be scanned
 * answers with the links it already has.
 */
import { createReadStream, existsSync, statSync } from "fs";
import type { Chat, ChatPrLink } from "shared";
import { chatFileService } from "./chat-file-service.js";
import { isSafeSessionId } from "./git-trail-backfill.js";
import { chatForRegistryId } from "./git-trail.js";
import { sessionRegistry, type SessionEvent } from "./session-registry.js";
import { getSessionProvider } from "../agents/factory.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("chat-pr-links");

/** How a transcript line that is a `pr-link` entry starts being one. Escaped inside any quoted text, so it only matches real entries. */
const MARKER = Buffer.from('"type":"pr-link"');
const NEWLINE = 0x0a;
const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]+$/;

/** The stored links, keeping only well-formed ones. */
export function parsePrLinks(raw: unknown): ChatPrLink[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (l): l is ChatPrLink =>
      !!l &&
      typeof l === "object" &&
      typeof l.repo === "string" &&
      REPO_PATTERN.test(l.repo) &&
      Number.isInteger(l.number) &&
      l.number > 0 &&
      typeof l.url === "string" &&
      typeof l.firstSeen === "string",
  );
}

const linkKey = (link: Pick<ChatPrLink, "repo" | "number">) => `${link.repo.toLowerCase()}#${link.number}`;

/** `a` then whatever only `b` has, one per PR, each with its earliest sighting. */
export function mergePrLinks(a: ChatPrLink[], b: ChatPrLink[]): ChatPrLink[] {
  const byKey = new Map<string, ChatPrLink>();
  for (const link of [...a, ...b]) {
    const known = byKey.get(linkKey(link));
    if (!known) byKey.set(linkKey(link), link);
    else if (link.firstSeen < known.firstSeen) byKey.set(linkKey(link), { ...known, firstSeen: link.firstSeen });
  }
  return [...byKey.values()];
}

/** One transcript line as a link, or null when it is not a usable `pr-link` entry. */
function toLink(line: string): ChatPrLink | null {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry?.type !== "pr-link") return null;
  const { prNumber, prRepository, prUrl, timestamp } = entry;
  if (!Number.isInteger(prNumber) || prNumber <= 0 || typeof prRepository !== "string" || !REPO_PATTERN.test(prRepository)) return null;
  // github.com only, like every lookup that would follow (github-prs.ts). The
  // URL is rebuilt rather than trusted.
  if (typeof prUrl !== "string" || !prUrl.startsWith("https://github.com/")) return null;
  return {
    repo: prRepository,
    number: prNumber,
    url: `https://github.com/${prRepository}/pull/${prNumber}`,
    firstSeen: typeof timestamp === "string" ? timestamp : new Date().toISOString(),
  };
}

/**
 * The `pr-link` entries of transcript `path` from byte `from` on, and the
 * byte the next scan resumes at — the end of the last complete line, so a
 * line caught mid-write is read whole next time.
 */
export async function scanPrLinks(path: string, from = 0): Promise<{ links: ChatPrLink[]; offset: number }> {
  let found: ChatPrLink[] = [];
  let offset = from;
  let carry: Buffer | null = null;
  for await (const chunk of createReadStream(path, { start: from, highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
    const end = buf.lastIndexOf(NEWLINE) + 1;
    carry = end < buf.length ? buf.subarray(end) : null;
    for (let at = buf.indexOf(MARKER); at !== -1 && at < end; ) {
      const lineStart = buf.lastIndexOf(NEWLINE, at) + 1;
      const lineEnd = buf.indexOf(NEWLINE, at);
      const link = toLink(buf.toString("utf8", lineStart, lineEnd));
      if (link) found = mergePrLinks(found, [link]);
      at = buf.indexOf(MARKER, lineEnd + 1);
    }
    offset += end;
  }
  return { links: found, offset };
}

export interface PrLinkDeps {
  /** A Claude Code session's transcript, or null when it is gone. */
  logPath: (sessionId: string) => string | null;
  /** A file's size in bytes, or null when it cannot be read. */
  size: (path: string) => number | null;
}

/** Session id → transcript path. A transcript never moves, so a hit is kept for the daemon's lifetime. */
const knownLogPaths = new Map<string, string>();

export const DEFAULT_PR_LINK_DEPS: PrLinkDeps = {
  logPath: (sessionId) => {
    const known = knownLogPaths.get(sessionId);
    if (known && existsSync(known)) return known;
    const found = getSessionProvider("claude-code" as never)?.resolveSession(sessionId)?.logPath;
    if (typeof found !== "string") return null;
    knownLogPaths.set(sessionId, found);
    return found;
  },
  size: (path) => {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  },
};

/** Syncs running now, by chat id — concurrent callers share one. */
const syncing = new Map<string, Promise<ChatPrLink[]>>();

async function sync(chat: Chat, deps: PrLinkDeps): Promise<ChatPrLink[]> {
  const meta = parseChatMetadata(chat.metadata);
  const stored = parsePrLinks(meta.prLinks);
  // Only Claude Code transcripts carry `pr-link` entries.
  if (typeof meta.provider === "string" && meta.provider && meta.provider !== "claude-code") return stored;
  const scanned: Record<string, number> = meta.prLinkScan && typeof meta.prLinkScan === "object" ? { ...(meta.prLinkScan as Record<string, number>) } : {};
  const sessionIds = new Set(
    [...(Array.isArray(meta.session_ids) ? meta.session_ids : []), chat.session_id].filter((id): id is string => typeof id === "string" && isSafeSessionId(id)),
  );

  let found: ChatPrLink[] = [];
  let moved = false;
  for (const sessionId of sessionIds) {
    const path = deps.logPath(sessionId);
    const size = path ? deps.size(path) : null;
    if (!path || size === null) continue;
    const done = typeof scanned[sessionId] === "number" ? scanned[sessionId] : 0;
    if (size === done) continue;
    // Smaller than what was read: not the file that was scanned. Start over.
    const { links, offset } = await scanPrLinks(path, size < done ? 0 : done);
    found = mergePrLinks(found, links);
    if (offset !== done) {
      scanned[sessionId] = offset;
      moved = true;
    }
  }
  if (!moved) return stored;

  // Read, merge and write on the freshest record with no await in between, so
  // nothing else written to the chat while its transcripts were read is lost.
  const fresh = chatFileService.getChatBySessionId(chat.session_id) ?? chat;
  const freshMeta = parseChatMetadata(fresh.metadata);
  const merged = mergePrLinks(parsePrLinks(freshMeta.prLinks), found);
  const prLinkScan = { ...(freshMeta.prLinkScan && typeof freshMeta.prLinkScan === "object" ? freshMeta.prLinkScan : {}), ...scanned };
  chatFileService.updateChatMetadataForRecord(fresh, { ...(merged.length > 0 && { prLinks: merged }), prLinkScan }, { touch: false });
  return merged;
}

/**
 * Bring `chat`'s links up to date with its transcripts and return them.
 * Never rejects: on any failure the links already stored are the answer.
 */
export function syncChatPrLinks(chat: Chat, deps: PrLinkDeps = DEFAULT_PR_LINK_DEPS): Promise<ChatPrLink[]> {
  const running = syncing.get(chat.id);
  if (running) return running;
  const run = sync(chat, deps)
    .catch((err) => {
      log.warn(`Reading the PR links of ${chat.id} failed: ${err instanceof Error ? err.message : err}`);
      return parsePrLinks(parseChatMetadata(chat.metadata).prLinks);
    })
    .finally(() => syncing.delete(chat.id));
  syncing.set(chat.id, run);
  return run;
}

/** Chats synced since the daemon started. Turn ends keep them current from there. */
const syncedOnce = new Set<string>();
let backlog: Promise<unknown> = Promise.resolve();

/**
 * Sync `chats` in the background, one at a time, each at most once per daemon
 * lifetime — for the Board, which lists every open card and must not wait on
 * (or keep re-reading) their histories. Returns at once.
 */
export function syncPrLinksInBackground(chats: Chat[], deps: PrLinkDeps = DEFAULT_PR_LINK_DEPS): void {
  for (const chat of chats) {
    if (syncedOnce.has(chat.id)) continue;
    syncedOnce.add(chat.id);
    backlog = backlog.then(() => syncChatPrLinks(chat, deps));
  }
}

/** Resolves once the background backlog has drained. For tests. */
export function prLinkBacklogIdle(): Promise<unknown> {
  return backlog;
}

/** Forget what has been synced. For tests. */
export function resetPrLinkSync(): void {
  syncedOnce.clear();
  knownLogPaths.clear();
}

let initialized = false;

/** Sync a chat's links whenever one of its turns ends — a PR made in the turn is known before anyone asks. */
export function initPrLinkRecorder(): void {
  if (initialized) return;
  initialized = true;
  sessionRegistry.on("change", (event: SessionEvent) => {
    if (event.event !== "session_stopped" || !event.chatId || event.chatId.startsWith("new-")) return;
    setImmediate(() => {
      try {
        const chat = chatForRegistryId(event.chatId);
        if (chat) void syncChatPrLinks(chat);
      } catch (err) {
        log.warn(`Syncing the PR links of ${event.chatId} failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  });
}
