import { chatFileService, type Chat } from "./chat-file-service.js";
import { buildLineageIndex, getParentChatId, walkToRootId } from "./chat-lineage.js";
import { isNativeRecord } from "./card-membership.js";
import { mergeTrails, parseGitTrail } from "./git-trail.js";
import { hasPendingRequest, repointParentOffers } from "./pending-requests.js";
import { repointCallbacksForParent } from "./session-callbacks.js";
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
 *   - **rerun** — the new session is the original strictly BEFORE a user
 *     prompt, and the prompt is then sent to it again (chat-rerun.ts). X is
 *     the last message kept. The original is `"superseded"`, as for
 *     continue-from. Rerunning the opening prompt has no history to fork: the
 *     route starts a fresh chat and passes it here as `adopt`.
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
 * ## Live linkage
 *
 * N is where the user works now, so what was waiting on C as a PARENT follows
 * N: pending phone-home callbacks with C as their parent are re-pointed to N
 * (a child finishing later re-invokes N, not the hidden original), C's
 * callback-chain depth goes with them, and open permission prompts a child
 * offered to C (`parentAnswers`) are re-addressed to N.
 *
 * For continue-from and rerun, only callbacks registered at or before the cutoff move:
 * N's history ends at the cutoff, so a child C started (or followed up) after
 * it belongs to the branch that went on — C — and its report would make no
 * sense in N. A compression keeps the whole conversation (part of it as a
 * summary), so every callback moves.
 *
 * Prompts raised LATER by a child still under C read their parent live, and
 * are offered to the chat that superseded it by the same rule — see
 * superseded-parent.ts.
 * C's own callbacks as a CHILD stay keyed on C: C is idle (supersede refuses a
 * running chat), and nothing will complete it until the user reopens it.
 *
 * ## What is NOT moved
 *
 * Things keyed by chat id elsewhere — a board card's id (it is the root's chat
 * id), job-run step records, artifacts — still name C. The card follows N
 * because card identity is lineage-root identity, so a card id cached by an
 * open tab goes stale.
 *
 * ## The running check
 *
 * `checkSupersedable` runs when the request arrives and again at the top of
 * {@link supersedeChat}. Continue-from, compress and a rerun with history are
 * synchronous from the first check to the second (the session write is sync
 * too), so nothing can register in between and the second check is
 * defence-in-depth there. A rerun of the opening prompt is not: it awaits a
 * fresh chat's startup (seconds, up to its timeout) before superseding, so in
 * that window C may start running, be continued or compressed from another tab,
 * or move in the tree. That route therefore re-reads C after the await,
 * re-checks it and its parent, and passes the FRESH record here — the late
 * check is a real gate on that path. On a refusal there, nothing has been
 * written to the chat store ({@link SupersedeRefusedError}).
 *
 * What neither check can see is a message POSTed to C that is still inside its
 * pre-registration awaits (effort/route probes, a few seconds at most): there
 * is no "starting" registry to consult. Such a run proceeds on C — the
 * original, now a child — and appends to C's own session; nothing is
 * corrupted, but its reply lands in the original rather than in N.
 *
 * ## Ordering
 *
 * The caller writes the session first. Then N is created, then C is rewritten,
 * then C's children. A crash after N's creation leaves N as a sibling of C (or
 * a second root) — a visible extra chat, never a broken tree; a crash before
 * that leaves only an orphan session file.
 *
 * Every write is quiet (`touch: false`) except N's creation: N is new. An
 * adopted N is already in the store, so the crash windows are the same with
 * "N's creation" read as "N's move".
 */

export type SupersedeKind = "continue" | "rerun" | "compress-before" | "compress-after";

/** The role the original is given under the new chat. */
export const SUPERSEDED_ROLE: Record<SupersedeKind, string> = {
  continue: "superseded",
  rerun: "superseded",
  "compress-before": "pre-compression",
  "compress-after": "pre-compression",
};

const TITLE_PREFIX: Record<SupersedeKind, string> = {
  continue: "Original: ",
  rerun: "Original: ",
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
  /** The message X the action was taken at — C's `forkedAt`, where N's thread shows the marker. */
  timestamp: string;
  /**
   * The last instant N's history holds, when that is not X. A rerun's X is the
   * last kept message that can carry a marker, but N keeps everything up to
   * one millisecond before the prompt — tool traffic after X included — so
   * stars, children and callbacks are measured against this instead. Recorded
   * on both records as `cutoff` so superseded-parent.ts measures the same way.
   * Ignored for compress-before, whose kept side is the one AFTER X.
   */
  keepThrough?: string;
  /** The new, already-written session N resumes. */
  newSessionId: string;
  /**
   * Metadata the caller decides for N — provider, model, effort, inherited
   * permissions etc. Position fields are added here and override it.
   */
  newChatMeta: Record<string, unknown>;
  /** Title for N when C has none; C's own title wins otherwise. */
  fallbackTitle?: string | null;
  /**
   * N already exists — a chat started fresh rather than resumed from a written
   * session (a rerun of the opening prompt) — so it is moved into C's place
   * instead of created. `newSessionId` is its session id.
   */
  adopt?: ChatRecord;
}

export interface SupersedeResult {
  chat: Chat;
  original: Chat | null;
  previousRootChatId: string;
  movedChildren: string[];
  restamped: number;
  /** Pending phone-home callbacks with C as their parent, now N's. */
  repointedCallbacks: number;
  /** Open child prompts offered to C, now offered to N. */
  repointedOffers: number;
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

/**
 * The original's new title. Any prefix an earlier supersede added is taken off
 * first, so a chat continued and then compressed reads "Before compression:
 * X", not "Before compression: Original: X" — the tree row's role icon already
 * says what each one is.
 */
function prefixedTitle(kind: SupersedeKind, title: string | null): string {
  const prefix = TITLE_PREFIX[kind];
  let base = (title ?? "").replace(/\s+/g, " ").trim();
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const p of new Set(Object.values(TITLE_PREFIX))) {
      if (base.startsWith(p)) {
        base = base.slice(p.length).trim();
        stripped = true;
      }
    }
  }
  if (!base) return prefix.replace(/:\s*$/, "");
  return `${prefix}${base}`;
}

/** Thrown by {@link supersedeChat} when the late re-check refuses; nothing was written. */
export class SupersedeRefusedError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

export function supersedeChat(opts: SupersedeOptions): SupersedeResult {
  const { chat, kind, timestamp, newSessionId } = opts;
  // Again, as defence-in-depth — see "The running check" above: the routes
  // reach here synchronously from their own check, so this cannot fire today.
  const late = checkSupersedable(chat);
  if (!late.ok) throw new SupersedeRefusedError(late.status, late.error);
  const cutoff = kind !== "compress-before" && opts.keepThrough ? opts.keepThrough : timestamp;
  const cutoffMs = new Date(cutoff).getTime();
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
    // An adopted N was filed by the new-chat path (a space from the folder
    // rules, say); what C did not have, N must not keep either.
    else if (opts.adopt) position[key] = undefined;
  }
  const stars = keptStars(kind, meta.starredMessages, cutoffMs);
  const newMeta = {
    ...opts.newChatMeta,
    session_ids: [newSessionId],
    ...(title && { title }),
    ...position,
    ...(stars.length > 0 && { starredMessages: stars, starredMessagesRev: 1 }),
    supersedes: { chatId: chat.id, kind, at: timestamp, ...(cutoff !== timestamp && { cutoff }) },
  };
  let created: Chat;
  if (opts.adopt) {
    const adopted = opts.adopt;
    // A rerun's N has been running, so it may already have recorded its own
    // git trail; the shallow merge below would replace that wholesale with
    // C's. Union the two instead — read and written with no await between,
    // so nothing can record in the gap.
    const carriedTrail = parseGitTrail(opts.newChatMeta.gitTrail);
    const ownTrail = parseGitTrail(parseChatMetadata(chatFileService.getChat(adopted.id)?.metadata).gitTrail);
    const trail = ownTrail.length > 0 ? { gitTrail: mergeTrails(carriedTrail, ownTrail) } : {};
    if (!chatFileService.updateChatMetadata(adopted.id, { ...newMeta, ...trail }, { touch: false }))
      throw new Error(`Could not move chat ${adopted.id} into ${chat.id}'s place`);
    created = chatFileService.getChat(adopted.id)!;
  } else {
    created = chatFileService.createChat(chat.folder, newSessionId, JSON.stringify(newMeta), chat.workspaceId);
  }

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
      supersededBy: { chatId: created.id, kind, at: new Date().toISOString(), ...(cutoff !== timestamp && { cutoff }) },
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

  // ── 4. What waited on C as a parent now waits on N ─────────────────
  const parentKeys = [chat.id, ...(chat.session_id && chat.session_id !== chat.id ? [chat.session_id] : [])];
  const includeCallback = kind === "continue" || kind === "rerun" ? (cb: { createdAt: number }) => cb.createdAt <= cutoffMs : undefined;
  const repointedCallbacks = rewritten ? repointCallbacksForParent(parentKeys, created.id, includeCallback).length : 0;
  const repointedOffers = rewritten ? repointParentOffers(parentKeys, created.id).length : 0;

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
      `${movedChildren.length} child(ren) moved, ${restamped} re-stamped, ${repointedCallbacks} callback(s) and ${repointedOffers} prompt offer(s) re-pointed)`,
  );
  return { chat: created, original: chatFileService.getChat(chat.id), previousRootChatId, movedChildren, restamped, repointedCallbacks, repointedOffers };
}
