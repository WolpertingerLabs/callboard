import { chatFileService, type Chat } from "./chat-file-service.js";
import { buildLineageIndex, getParentChatId, walkToRootId } from "./chat-lineage.js";
import { isNativeRecord } from "./card-membership.js";
import { hasPendingRequest } from "./pending-requests.js";
import { sessionRegistry } from "./session-registry.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("chat-supersede");

/**
 * Supersede a chat: a NEW chat, resuming a session written from the original's
 * history, takes the original's place in the tree, and the original is kept as
 * its child.
 *
 * Three per-message actions end here, each having written the new session
 * first:
 *
 *   - **continue-from** — the new session is the original up to and including
 *     message X (a fork). The original becomes a `"superseded"` child: it is
 *     the branch that went on past X.
 *   - **compress-before / compress-after** — the new session is the original
 *     with the part before / after X replaced by a summary. The original
 *     becomes a `"pre-compression"` child: the uncompressed transcript, kept so
 *     the compression can be undone by going back to it.
 *
 * ## Why a new chat, not a session swap
 *
 * The alternative — pointing the original chat id at the new session — would
 * keep every link to the chat id working, but silently rewrite what that id
 * means: a parent's callback, a job step or a card that referred to "this
 * conversation" would resume a different one. A new chat id makes the change
 * visible and keeps the original exactly as it was.
 *
 * ## What "takes its place" means
 *
 * The new chat N inherits from the original C every field that positions C:
 *   - its parentage (`parentChatId`/`forkedFrom`, `chatRole`, `forkedAt`, and
 *     `rootChatId` resolved fresh as the fork route does), so a child C's slot
 *     under its parent — fork marker included — is now N's;
 *   - the root-only fields (`card` face fields, `treeArchived*`,
 *     `sidebarFolder`, `spaceId`) and `pinned`. These MOVE: N is the row and the
 *     card now, and leaving them on C (now a member) would be the stale card
 *     debris chat-detach clears for the same reason.
 *
 * C then becomes N's child: `parentChatId = N`, `forkedAt = X` (so N's thread
 * gets the inline marker at X), the new role, and a prefixed title so the two
 * are distinguishable in the tree.
 *
 * When C was a root, N is the root now: every chat whose `rootChatId` stamp
 * names C is re-stamped to N — including job-step chats tied to the tree by the
 * stamp alone. Unlike chat-detach (which splits a subtree OFF and cannot tell
 * which job steps belonged to it), here the whole tree keeps its shape and only
 * its root's id changes, so everything that named the old root follows.
 *
 * ## C's existing children
 *
 * A child whose `forkedAt` names a message N still has verbatim moves to N,
 * so its fork marker lands in the conversation that continues: for
 * continue-from and compress-after that is `forkedAt <= X`, for
 * compress-before `forkedAt >= X`. Everything else stays under C, the
 * transcript it actually branched from. Children with NO `forkedAt` (spawned
 * subagents, linked chats, forks from before the field existed) stay under C:
 * nothing records which message they came from, and C is the conversation that
 * spawned them.
 *
 * ## What is NOT moved
 *
 * Phone-home callbacks and open prompts stay keyed on C, which spawned them;
 * C is idle (supersede refuses a running chat), and its children's completion
 * still reports to whoever was waiting on them. Things keyed by chat id
 * elsewhere — a board card's id (it is the root's chat id), job-run step
 * records, artifacts — still name C. The card follows N because card identity
 * is lineage-root identity, so a card id cached by an open tab goes stale.
 *
 * ## Ordering
 *
 * The caller writes the session first. Then N is created, then C is rewritten,
 * then C's children. A crash after N's creation leaves N as a sibling of C (or
 * a second root) — a visible extra chat, never a broken tree; a crash before
 * that leaves only an orphan session file.
 *
 * Every write is quiet (`touch: false`) except N's creation: N is new.
 */

export type SupersedeKind = "continue" | "compress-before" | "compress-after";

/** The role the original is given under the new chat. */
export const SUPERSEDED_ROLE: Record<SupersedeKind, string> = {
  continue: "superseded",
  "compress-before": "pre-compression",
  "compress-after": "pre-compression",
};

const TITLE_PREFIX: Record<SupersedeKind, string> = {
  continue: "Original: ",
  "compress-before": "Before compression: ",
  "compress-after": "Before compression: ",
};

/** Fields that position a root chat and move to the chat that takes its place. */
const ROOT_FIELDS = ["card", "treeArchived", "treeArchivedAt", "sidebarFolder", "spaceId", "pinned"] as const;

type ChatRecord = Pick<Chat, "id" | "session_id" | "folder" | "metadata"> & {
  workspaceId?: string;
  created_at?: string;
  updated_at?: string;
  _from_filesystem?: boolean;
};

export type SupersedeCheck = { ok: true } | { ok: false; status: 400 | 409; error: string };

/**
 * Whether `chat` may be superseded right now. Run BEFORE writing the new
 * session, so a refusal costs nothing.
 */
export function checkSupersedable(chat: ChatRecord): SupersedeCheck {
  if (isNativeRecord(chat)) {
    return {
      ok: false,
      status: 409,
      error: "This is a native Codex subagent — its history belongs to the Codex session that ran it, so it cannot be rewritten here",
    };
  }
  const meta = parseChatMetadata(chat.metadata);
  if (meta.provider === "acp") {
    return { ok: false, status: 400, error: "ACP chats keep their history inside the agent's process, so they cannot be continued or compressed" };
  }
  const keys = [chat.id, chat.session_id].filter(Boolean);
  if (keys.some((k) => sessionRegistry.has(k))) return { ok: false, status: 409, error: "This chat is still running — stop it or wait for it to finish first" };
  if (keys.some((k) => hasPendingRequest(k))) return { ok: false, status: 409, error: "This chat is waiting on a permission prompt — answer it first" };
  return { ok: true };
}

export interface SupersedeOptions {
  /** The original chat, as `findChat` returns it. */
  chat: ChatRecord;
  kind: SupersedeKind;
  /** The message X the action was taken at. */
  timestamp: string;
  /** The new, already-written session N resumes. */
  newSessionId: string;
  /**
   * Metadata the caller decides for N — provider, model, effort, inherited
   * permissions etc. Position fields are added here and override it.
   */
  newChatMeta: Record<string, unknown>;
  /** Title for N when C has none; C's own title wins otherwise. */
  fallbackTitle?: string | null;
}

export interface SupersedeResult {
  chat: Chat;
  original: Chat | null;
  previousRootChatId: string;
  movedChildren: string[];
  restamped: number;
}

/** Whether a fork point still exists verbatim in the new chat. */
function branchPointKept(kind: SupersedeKind, forkedAt: unknown, cutoffMs: number): boolean {
  if (typeof forkedAt !== "string") return false;
  const ms = new Date(forkedAt).getTime();
  if (isNaN(ms)) return false;
  return kind === "compress-before" ? ms >= cutoffMs : ms <= cutoffMs;
}

/** Starred keys (`role@timestamp#ordinal`) whose message is kept verbatim in the new chat. */
export function keptStars(kind: SupersedeKind, stars: unknown, cutoffMs: number): string[] {
  if (!Array.isArray(stars)) return [];
  return stars.filter((key): key is string => {
    if (typeof key !== "string") return false;
    const at = key.indexOf("@");
    const hash = key.lastIndexOf("#");
    if (at === -1 || hash <= at) return false;
    return branchPointKept(kind, key.slice(at + 1, hash), cutoffMs);
  });
}

function prefixedTitle(kind: SupersedeKind, title: string | null): string {
  const prefix = TITLE_PREFIX[kind];
  const base = (title ?? "").replace(/\s+/g, " ").trim();
  if (!base) return prefix.replace(/:\s*$/, "");
  return base.startsWith(prefix) ? base : `${prefix}${base}`;
}

export function supersedeChat(opts: SupersedeOptions): SupersedeResult {
  const { chat, kind, timestamp, newSessionId } = opts;
  const cutoffMs = new Date(timestamp).getTime();
  const meta: Record<string, any> = parseChatMetadata(chat.metadata);

  // A chat known only from its session log gets a record first: everything
  // below rewrites its metadata.
  if (chat._from_filesystem) {
    chatFileService.upsertChat(chat.id, chat.folder, chat.session_id, {
      metadata: chat.metadata || "{}",
      ...(chat.created_at && { created_at: chat.created_at }),
      ...(chat.updated_at && { updated_at: chat.updated_at }),
    });
  }

  // Resolved BEFORE any write, while C still resolves to its old root.
  const previousRootChatId = walkToRootId(chat.id);
  const parentId = getParentChatId(meta);
  const wasRoot = previousRootChatId === chat.id;
  const title: string | null = (typeof meta.title === "string" && meta.title.trim()) || opts.fallbackTitle || null;

  // ── 1. N, in C's place ─────────────────────────────────────────────
  const position: Record<string, unknown> = {};
  if (parentId) {
    position.parentChatId = parentId;
    if (meta.forkedFrom) position.forkedFrom = meta.forkedFrom;
    position.rootChatId = previousRootChatId;
  } else if (typeof meta.rootChatId === "string" && meta.rootChatId) {
    // A job-step chat: no parent pointer, tied to its run's tree by the stamp.
    position.rootChatId = meta.rootChatId;
  }
  for (const key of ["chatRole", "forkedAt", ...ROOT_FIELDS] as const) {
    if (meta[key] !== undefined) position[key] = meta[key];
  }
  const stars = keptStars(kind, meta.starredMessages, cutoffMs);
  const newMeta = {
    ...opts.newChatMeta,
    session_ids: [newSessionId],
    ...(title && { title }),
    ...position,
    ...(stars.length > 0 && { starredMessages: stars, starredMessagesRev: 1 }),
    supersedes: { chatId: chat.id, kind, at: timestamp },
  };
  const created = chatFileService.createChat(chat.folder, newSessionId, JSON.stringify(newMeta), chat.workspaceId);

  // ── 2. C, under N ──────────────────────────────────────────────────
  const cleared = Object.fromEntries(ROOT_FIELDS.map((k) => [k, undefined]));
  const rewritten = chatFileService.updateChatMetadata(
    chat.id,
    {
      ...cleared,
      parentChatId: created.id,
      forkedFrom: created.id,
      rootChatId: wasRoot ? created.id : previousRootChatId,
      chatRole: SUPERSEDED_ROLE[kind],
      forkedAt: timestamp,
      title: prefixedTitle(kind, title),
      supersededBy: { chatId: created.id, kind, at: new Date().toISOString() },
    },
    { touch: false },
  );
  if (!rewritten) log.warn(`supersede ${chat.id}: could not rewrite the original's record; new chat ${created.id} stands beside it`);

  // ── 3. C's children, and the root stamp ────────────────────────────
  const snapshot = chatFileService.getAllChats();
  const index = buildLineageIndex(snapshot);
  const movedChildren: string[] = [];
  if (rewritten) {
    for (const child of index.childrenByParent.get(chat.id) ?? []) {
      if (child.id === created.id) continue;
      const childMeta = parseChatMetadata(child.metadata);
      if (!branchPointKept(kind, childMeta.forkedAt, cutoffMs)) continue;
      const patch: Record<string, unknown> = { parentChatId: created.id };
      if (childMeta.forkedFrom === chat.id) patch.forkedFrom = created.id;
      if (chatFileService.updateChatMetadataForRecord(child, patch, { touch: false })) movedChildren.push(child.id);
      else log.warn(`supersede ${chat.id}: could not move child ${child.id} to ${created.id}`);
    }
  }

  let restamped = 0;
  if (wasRoot && rewritten) {
    for (const other of snapshot) {
      if (other.id === created.id || other.id === chat.id) continue;
      const otherMeta = parseChatMetadata(other.metadata);
      // Named the old root by stamp, or under it by parent pointer with no stamp.
      const stampedOld = otherMeta.rootChatId === chat.id;
      const unstampedMember = !otherMeta.rootChatId && index.existingRootIdOf(other.id) === created.id;
      if (!stampedOld && !unstampedMember) continue;
      if (chatFileService.updateChatMetadataForRecord(other, { rootChatId: created.id }, { touch: false })) restamped++;
      else log.warn(`supersede ${chat.id}: could not re-stamp rootChatId on ${other.id}`);
    }
  }

  log.info(
    `Superseded chat ${chat.id} by ${created.id} (${kind} at ${timestamp}; ${wasRoot ? "root" : `child of ${parentId ?? previousRootChatId}`}; ` +
      `${movedChildren.length} child(ren) moved, ${restamped} re-stamped)`,
  );
  return { chat: created, original: chatFileService.getChat(chat.id), previousRootChatId, movedChildren, restamped };
}
