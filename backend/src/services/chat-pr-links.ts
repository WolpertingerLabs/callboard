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
import { isGitHubRepoName } from "./github-prs.js";
import { sessionRegistry, type SessionEvent } from "./session-registry.js";
import { getSessionProvider } from "../agents/factory.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("chat-pr-links");

/** How a transcript line that is a `pr-link` entry starts being one. Escaped inside any quoted text, so it only matches real entries. */
const MARKER = Buffer.from('"type":"pr-link"');
const NEWLINE = 0x0a;
/** `owner/name`, each a name GitHub would accept — the rule a remote URL is held to. */
const isRepoSlug = (slug: string) => {
  const parts = slug.split("/");
  return parts.length === 2 && isGitHubRepoName(parts[0], parts[1]);
};
/** A PR number is a GraphQL `Int`; anything larger is spliced into the query as `1e+21` and fails every PR asked about with it. */
const isPrNumber = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 2_147_483_647;

/** The stored links, keeping only well-formed ones. */
export function parsePrLinks(raw: unknown): ChatPrLink[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (l): l is ChatPrLink =>
      !!l &&
      typeof l === "object" &&
      typeof l.repo === "string" &&
      isRepoSlug(l.repo) &&
      isPrNumber(l.number) &&
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
  if (!isPrNumber(prNumber) || typeof prRepository !== "string" || !isRepoSlug(prRepository)) return null;
  // github.com only, like every lookup that would follow (github-prs.ts). The
  // URL is rebuilt rather than trusted.
  if (typeof prUrl !== "string" || !prUrl.startsWith("https://github.com/")) return null;
  // Claude Code stamps every entry. One without a time is skipped rather than
  // given the time of the scan, which `firstSeen` would then claim as fact.
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) return null;
  return {
    repo: prRepository,
    number: prNumber,
    url: `https://github.com/${prRepository}/pull/${prNumber}`,
    firstSeen: timestamp,
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
  const take = (line: string) => {
    const link = toLink(line);
    if (link) found = mergePrLinks(found, [link]);
  };
  // A line longer than one read is carried as its pieces, each searched once,
  // and joined only if it turns out to be an entry: re-joining and
  // re-searching the whole carry per read is quadratic in the line's length.
  let carry: Buffer[] = [];
  let carryBytes = 0;
  let carryHasMarker = false;
  /** The carry's last bytes, for a marker split across two reads. */
  let tail: Buffer = Buffer.alloc(0);
  const overlap = MARKER.length - 1;
  for await (const chunk of createReadStream(path, { start: from, highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    let rest: Buffer = chunk;
    if (carry.length > 0) {
      const newline = chunk.indexOf(NEWLINE);
      const head = newline === -1 ? chunk : chunk.subarray(0, newline);
      carryHasMarker ||= head.indexOf(MARKER) !== -1 || Buffer.concat([tail, head.subarray(0, overlap)]).indexOf(MARKER) !== -1;
      if (newline === -1) {
        carry.push(chunk);
        carryBytes += chunk.length;
        tail = chunk.length >= overlap ? chunk.subarray(-overlap) : Buffer.concat([tail, chunk]).subarray(-overlap);
        continue;
      }
      if (carryHasMarker) take(Buffer.concat([...carry, head]).toString("utf8"));
      offset += carryBytes + newline + 1;
      carry = [];
      rest = chunk.subarray(newline + 1);
    }
    const end = rest.lastIndexOf(NEWLINE) + 1;
    for (let at = rest.indexOf(MARKER); at !== -1 && at < end; ) {
      const lineStart = rest.lastIndexOf(NEWLINE, at) + 1;
      const lineEnd = rest.indexOf(NEWLINE, at);
      take(rest.toString("utf8", lineStart, lineEnd));
      at = rest.indexOf(MARKER, lineEnd + 1);
    }
    offset += end;
    if (end < rest.length) {
      const partial = rest.subarray(end);
      carry = [partial];
      carryBytes = partial.length;
      carryHasMarker = partial.indexOf(MARKER) !== -1;
      tail = partial.subarray(-overlap);
    }
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
/**
 * Sessions with no transcript. Kept for the daemon's lifetime too: a miss
 * walks every project directory, and a chat whose transcript is gone would
 * pay that on every sync. A turn's end forgets its chat's (see
 * {@link initPrLinkRecorder}) — that is when a transcript can have appeared.
 */
const missingLogPaths = new Set<string>();

export const DEFAULT_PR_LINK_DEPS: PrLinkDeps = {
  logPath: (sessionId) => {
    const known = knownLogPaths.get(sessionId);
    if (known && existsSync(known)) return known;
    if (missingLogPaths.has(sessionId)) return null;
    const found = getSessionProvider("claude-code" as never)?.resolveSession(sessionId)?.logPath;
    if (typeof found !== "string") {
      missingLogPaths.add(sessionId);
      return null;
    }
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
  const scanned: Record<string, unknown> = meta.prLinkScan && typeof meta.prLinkScan === "object" ? (meta.prLinkScan as Record<string, unknown>) : {};
  const sessionIds = new Set(
    [...(Array.isArray(meta.session_ids) ? meta.session_ids : []), chat.session_id].filter((id): id is string => typeof id === "string" && isSafeSessionId(id)),
  );

  let found: ChatPrLink[] = [];
  const moved: Record<string, number> = {};
  for (const sessionId of sessionIds) {
    const path = deps.logPath(sessionId);
    const size = path ? deps.size(path) : null;
    if (!path || size === null) continue;
    const done = typeof scanned[sessionId] === "number" ? (scanned[sessionId] as number) : 0;
    if (size === done) continue;
    // Smaller than what was read: not the file that was scanned. Start over.
    const { links, offset } = await scanPrLinks(path, size < done ? 0 : done);
    found = mergePrLinks(found, links);
    if (offset !== done) moved[sessionId] = offset;
  }
  if (Object.keys(moved).length === 0) return stored;

  // Read, merge and write on the freshest record with no await in between, so
  // nothing else written to the chat while its transcripts were read is lost.
  const fresh = chatFileService.getChatBySessionId(chat.session_id) ?? chat;
  const freshMeta = parseChatMetadata(fresh.metadata);
  const merged = mergePrLinks(parsePrLinks(freshMeta.prLinks), found);
  // Only the offsets this run moved: `chat` may be an older snapshot than
  // `fresh`, and its other offsets would rewind what a later sync advanced.
  const prLinkScan = { ...(freshMeta.prLinkScan && typeof freshMeta.prLinkScan === "object" ? freshMeta.prLinkScan : {}), ...moved };
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
 *
 * The event loop gets a turn between chats: a sync only awaits when a
 * transcript has grown, so a backlog of up-to-date chats — the first Board
 * load after a restart — would otherwise run to its end as one microtask
 * chain, with every request waiting behind it.
 */
export function syncPrLinksInBackground(chats: Chat[], deps: PrLinkDeps = DEFAULT_PR_LINK_DEPS): void {
  for (const chat of chats) {
    if (syncedOnce.has(chat.id)) continue;
    syncedOnce.add(chat.id);
    backlog = backlog.then(() => syncChatPrLinks(chat, deps)).then(() => new Promise<void>((resolvePromise) => setImmediate(resolvePromise)));
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
  missingLogPaths.clear();
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
        if (!chat) return;
        // The turn that just ended may have written the first line of a
        // transcript that was not there when it was last looked for.
        missingLogPaths.delete(chat.session_id);
        void syncChatPrLinks(chat);
      } catch (err) {
        log.warn(`Syncing the PR links of ${event.chatId} failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  });
}
