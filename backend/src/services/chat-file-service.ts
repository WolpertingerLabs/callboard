import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "node:crypto";
import type { Chat } from "shared/types/index.js";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";
import { isMtimeSettled } from "../utils/mtime-freshness.js";

const log = createLogger("chat-file");

export type { Chat };

const chatsDir = join(DATA_DIR, "chats");

// Ensure chats directory exists
if (!existsSync(chatsDir)) {
  mkdirSync(chatsDir, { recursive: true });
}

/**
 * Parsed records, keyed by filename, with the stat they were parsed at.
 *
 * {@link ChatFileService.getAllChats} is called on the chat-list path and on
 * ~9 others, and it used to read and `JSON.parse` every record on every call —
 * 8,167 files, ~41 ms, per request. The records are almost entirely unchanged
 * between calls, so this keeps them and re-reads only what `stat` says moved.
 *
 * The cost is resident memory: this holds every record for the life of the
 * process, where the old code allocated the same objects per call and dropped
 * them. It is the same data either way — ~5 MB of JSON across 8k records on the
 * profiled dir — so this trades GC churn for a flat footprint that grows only
 * with the number of chats, not with request rate.
 *
 * Freshness is the `(mtimeNs, size)` rule `chats-snapshot.ts` states in full,
 * including why an entry inside its own mtime tick is not cacheable — see
 * {@link isMtimeSettled}. Nanoseconds rather than `mtimeMs`, because on a
 * whole-second filesystem a millisecond field cannot distinguish two writes the
 * clock never separated, and these records are the equal-length-rewrite shape
 * that makes `size` no help either.
 */
const recordCache = new Map<string, { mtimeNs: bigint; size: bigint; chat: Chat }>();

/**
 * The last scan's records, sorted newest-first, or null when the next scan must
 * re-sort. Kept because the sort is not the cheap half: the comparator it
 * replaced built two `Date` objects per comparison, ~220k of them across 8k
 * records, for 45–49 ms on top of the read. See {@link sortByUpdatedAt}.
 *
 * Only reused when a scan re-read nothing and the file set was unchanged, so it
 * can never outlive the records it was built from.
 */
let sortedCache: Chat[] | null = null;

/**
 * Sort records by `updated_at`, newest first.
 *
 * The timestamp is parsed once per record rather than once per comparison.
 * `Array.prototype.sort` does ~n·log n comparisons — 110k across 8k records —
 * and the old `new Date(b.updated_at).getTime() - new Date(a.updated_at)…`
 * built two `Date` objects in each of them. Precomputing the key is the same
 * ordering for 49 ms less; it was checked against the old comparator over a
 * real 8,167-record directory and the two agree exactly.
 *
 * A malformed timestamp keys as 0 and sorts last. The old comparator returned
 * `NaN` for it, which makes the comparison inconsistent and the resulting
 * order unspecified — so this is a previously-undefined case being pinned
 * down, not a defined one being changed.
 */
function sortByUpdatedAt(chats: Chat[]): Chat[] {
  const keys = new Map<Chat, number>();
  for (const chat of chats) keys.set(chat, Date.parse(chat.updated_at) || 0);
  return chats.sort((a, b) => keys.get(b)! - keys.get(a)!);
}

/**
 * Forget one record, and the sorted view built over it.
 *
 * Called by this service's own writers, and belt-and-braces alongside the
 * mtime-tick rule rather than a substitute for it: the tick rule is what makes
 * a write by *anyone* visible (another process, a hand edit), and it covers
 * these writes too. This makes ours exact without depending on any reasoning
 * about clock granularity, which is the part most likely to be wrong on a
 * filesystem nobody tested on.
 */
function invalidateRecord(sessionId: string): void {
  recordCache.delete(`${sessionId}.json`);
  sortedCache = null;
}

export class ChatFileService {
  /**
   * Every record, newest first, optionally paginated.
   *
   * Revalidates against the directory on each call — one `readdir` plus one
   * `stat` per file, ~22 ms against the ~91 ms a full re-read and re-sort cost
   * — so a record changed by anything at all, including something outside this
   * process, is picked up.
   *
   * The scan assembles the result itself and consults {@link recordCache} only
   * to avoid a read. That distinction is load-bearing: a record inside its own
   * mtime tick is deliberately not cached, and deriving the result from the
   * cache instead would drop every just-written chat out of the sidebar for as
   * long as its tick stayed open.
   *
   * Returned records are shallow copies. `Chat` is flat, so that is total
   * isolation, and it means a caller that mutates what it gets back — several
   * do — cannot corrupt what the next caller reads.
   */
  getAllChats(limit?: number, offset?: number): Chat[] {
    try {
      const files = readdirSync(chatsDir).filter((file) => file.endsWith(".json"));
      const records: Chat[] = [];
      const present = new Set<string>();
      // Any read at all invalidates the memoised order: the record that moved
      // may have moved in `updated_at`. Only a scan that read nothing, over an
      // unchanged file set, can reuse it.
      let reread = false;

      for (const file of files) {
        const filepath = join(chatsDir, file);
        let stats;
        try {
          stats = statSync(filepath, { bigint: true });
        } catch {
          // Deleted between the readdir and here — nothing to return for it,
          // and the entry goes with it.
          recordCache.delete(file);
          reread = true;
          continue;
        }
        present.add(file);

        const cached = recordCache.get(file);
        if (cached && cached.mtimeNs === stats.mtimeNs && cached.size === stats.size) {
          records.push(cached.chat);
          continue;
        }

        // Only entries whose tick has already closed are worth remembering; see
        // isMtimeSettled. Computed before the read so a slow read cannot talk us
        // into trusting a timestamp that was fresh when we opened it.
        const cacheable = isMtimeSettled(stats.mtimeNs);

        reread = true;
        try {
          const chat: Chat = JSON.parse(readFileSync(filepath, "utf8"));
          // A record still inside its tick is returned but not remembered, so
          // the next call re-reads it rather than latching a value a same-tick
          // rewrite could have superseded.
          if (cacheable) recordCache.set(file, { mtimeNs: stats.mtimeNs, size: stats.size, chat });
          else recordCache.delete(file);
          records.push(chat);
        } catch (error) {
          // Unreadable or corrupt: not cached either way, so a transient
          // failure is retried on the next call rather than latched into a
          // chat that has silently vanished from the list.
          log.error(`Error reading chat file ${file}: ${error}`);
          recordCache.delete(file);
        }
      }

      for (const file of recordCache.keys()) {
        if (!present.has(file)) {
          recordCache.delete(file);
          reread = true;
        }
      }

      // The size check is not redundant with `reread`. A record inside its own
      // mtime tick is returned but not cached, so when its file disappears
      // out-of-band — a second daemon on the same data dir, a manual `rm` —
      // neither the stat-catch nor the prune loop above sees it: it is absent
      // from `readdir` and was never in `recordCache`. Every *addition* forces
      // a read and so raises `reread`, which leaves a shrunk set as the one way
      // the assembled records can differ from the memoised order while nothing
      // was read. Without this, the deleted chat keeps being served until some
      // unrelated record happens to change.
      if (reread || !sortedCache || sortedCache.length !== records.length) sortedCache = sortByUpdatedAt(records);

      const start = offset || 0;
      const end = limit ? start + limit : undefined;
      return sortedCache.slice(start, end).map((chat) => ({ ...chat }));
    } catch (error) {
      log.error(`Error reading chats directory: ${error}`);
      return [];
    }
  }

  // Get a chat by session id — the direct filename read, and nothing else.
  //
  // Records are filed as `<session_id>.json` (see saveChat), so this is a
  // single stat + read. Use it wherever the caller's id is provably a session
  // id, because getChat's miss path is a readdir + parse of every record in
  // the directory — ~88 ms median across 8k records on a real data dir, paid
  // per lookup.
  //
  // `chat.id` and `session_id` are NOT separate namespaces: the dominant
  // creation path is `upsertChat(sessionId, folder, sessionId)`
  // (claude.ts:2056), which makes them equal, and all 8,039 records on the
  // profiled data dir have `id === session_id === filename`. createChat's
  // randomUUID is reached only from the two chats.ts routes. So for a session
  // id the fallback scan almost always just re-derives what the direct read
  // already answered — and when there is no record it is guaranteed to find
  // nothing.
  //
  // The one shape it can still resolve, and this method deliberately will not:
  // a record whose session id changed after creation (claude.ts:2151 resumes
  // with a new session id, so upsertChat refiles it and leaves `chat.id` as
  // the *superseded* session id). Looking that superseded id up here returns
  // null where getChat would have found the record by scanning. Accepted
  // rather than guarded — see the call site in utils/chat-search.ts for the
  // reasoning and the bound on what it costs.
  //
  // Callers with an ambiguous id, or ones that genuinely want the by-`chat.id`
  // lookup, still want getChat.
  getChatBySessionId(sessionId: string): Chat | null {
    const filepath = join(chatsDir, `${sessionId}.json`);
    if (!existsSync(filepath)) return null;

    try {
      return JSON.parse(readFileSync(filepath, "utf8"));
    } catch (error) {
      log.error(`Error reading chat file for session ${sessionId}: ${error}`);
      return null;
    }
  }

  // Get a specific chat by ID
  getChat(id: string): Chat | null {
    // Try to find by session_id first (filename)
    const bySession = this.getChatBySessionId(id);
    if (bySession) return bySession;

    // If not found by session_id, search all files for matching chat id
    try {
      const files = readdirSync(chatsDir).filter((file) => file.endsWith(".json"));
      for (const file of files) {
        try {
          const content = readFileSync(join(chatsDir, file), "utf8");
          const chat: Chat = JSON.parse(content);
          if (chat.id === id) {
            return chat;
          }
        } catch (error) {
          log.error(`Error reading chat file ${file}: ${error}`);
        }
      }
    } catch (error) {
      log.error(`Error searching for chat: ${error}`);
    }

    return null;
  }

  // Create a new chat (requires session_id)
  //
  // `workspaceId` links the chat to the Workspace it runs in. Pass it whenever
  // the new chat inherits a folder that already belongs to one (a fork), so it
  // lands in the same set Phase 2's archive cascade acts on — see
  // plans/workspace-object.md.
  createChat(folder: string, sessionId: string, metadata: string = "{}", workspaceId?: string): Chat {
    log.debug(`createChat — folder=${folder}, sessionId=${sessionId}`);
    const id = randomUUID();
    const now = new Date().toISOString();

    const chat: Chat = {
      id,
      folder,
      session_id: sessionId,
      session_log_path: null,
      metadata,
      ...(workspaceId && { workspaceId }),
      created_at: now,
      updated_at: now,
    };

    this.saveChat(chat);
    return chat;
  }

  // Update an existing chat (returns false if chat not found)
  updateChat(id: string, updates: Partial<Chat>): boolean {
    log.debug(`updateChat — id=${id}`);
    const chat = this.getChat(id);
    if (!chat) {
      return false;
    }

    const oldSessionId = chat.session_id;
    const updatedChat = {
      ...chat,
      ...updates,
      updated_at: new Date().toISOString(),
    };

    // If session_id changed, we need to rename the file
    if (updates.session_id && updates.session_id !== oldSessionId) {
      this.deleteChat(oldSessionId);
    }

    this.saveChat(updatedChat);
    return true;
  }

  // Create or update a chat - useful when chat might only exist in filesystem
  //
  // CAUTION: `updates.metadata` replaces the ENTIRE metadata blob (last write
  // wins). Never pass a metadata string parsed before an await or event
  // boundary — concurrent field writes (cardId, title, lastReadAt, ...) would
  // be silently dropped. For field-level changes use updateChatMetadata,
  // which read-merge-writes atomically; only pass metadata here when it was
  // derived from a fresh synchronous read (or the record is known not to exist).
  upsertChat(id: string, folder: string, sessionId: string, updates: Partial<Chat>): Chat {
    log.debug(`upsertChat — id=${id}, folder=${folder}, sessionId=${sessionId}`);
    const existingChat = this.getChat(id);

    if (existingChat) {
      // Update existing.
      //
      // Workspace linkage is write-once here: an existing chat keeps whatever
      // its record already has. Re-pointing a live chat at a different
      // workspace would silently move it out of the set Phase 2's archive
      // cascade interrupts, while its session keeps running in the old
      // directory. Backfill/relink is updateChat's job, not upsert's.
      const safeUpdates = { ...updates };
      delete safeUpdates.workspaceId;
      const oldSessionId = existingChat.session_id;
      const updatedChat = {
        ...existingChat,
        ...safeUpdates,
        session_id: sessionId || existingChat.session_id,
        updated_at: new Date().toISOString(),
      };

      // If session_id changed, we need to rename the file
      if (sessionId && sessionId !== oldSessionId) {
        this.deleteChat(oldSessionId);
      }

      this.saveChat(updatedChat);
      return updatedChat;
    } else {
      // Create new. Honor caller-supplied timestamps when present so a
      // view-only write (e.g. carding a filesystem-only chat) can preserve
      // the session's real updated_at instead of resurfacing it as fresh.
      const now = new Date().toISOString();
      const newChat: Chat = {
        id,
        folder,
        session_id: sessionId,
        session_log_path: null,
        metadata: updates.metadata || "{}",
        // Optional workspace linkage. `folder` above is unaffected and stays
        // the truth for log paths — see plans/workspace-object.md.
        ...(updates.workspaceId && { workspaceId: updates.workspaceId }),
        created_at: updates.created_at || now,
        updated_at: updates.updated_at || now,
      };

      this.saveChat(newChat);
      return newChat;
    }
  }

  // Update specific metadata fields on a chat (read-merge-write).
  // `touch: false` preserves updated_at — for view-only writes (board card
  // membership) that must not resurface a chat as unread or reorder it in
  // the sidebar.
  updateChatMetadata(id: string, fields: Record<string, unknown>, opts?: { touch?: boolean }): boolean {
    const chat = this.getChat(id);
    if (!chat) return false;

    try {
      const meta = JSON.parse(chat.metadata || "{}");
      const merged = { ...meta, ...fields };
      chat.metadata = JSON.stringify(merged);
      if (opts?.touch !== false) chat.updated_at = new Date().toISOString();
      this.saveChat(chat);
      return true;
    } catch (error) {
      log.error(`Error updating chat metadata for ${id}: ${error}`);
      return false;
    }
  }

  // The chat's current per-chat model override, if any — a live read of
  // metadata.model, the field the model switcher rewrites mid-chat (and the
  // session-starting tools read to default a child onto the calling chat's
  // model). Blank or unreadable metadata is simply "no override": the chat
  // is running on the provider's configured default.
  getModelOverride(id: string): string | undefined {
    const chat = this.getChat(id);
    if (!chat) return undefined;
    try {
      const meta = JSON.parse(chat.metadata || "{}");
      const model = meta?.model;
      return typeof model === "string" && model.trim() ? model.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  // Delete a chat
  deleteChat(sessionId: string): boolean {
    log.debug(`deleteChat — sessionId=${sessionId}`);
    const filepath = join(chatsDir, `${sessionId}.json`);

    if (!existsSync(filepath)) {
      return false;
    }

    try {
      unlinkSync(filepath);
      invalidateRecord(sessionId);
      return true;
    } catch (error) {
      log.error(`Error deleting chat file ${sessionId}: ${error}`);
      return false;
    }
  }

  // Save chat to file (uses session_id as filename)
  private saveChat(chat: Chat): void {
    const filepath = join(chatsDir, `${chat.session_id}.json`);
    writeFileSync(filepath, JSON.stringify(chat, null, 2));
    invalidateRecord(chat.session_id);
  }
}

// Export singleton instance
export const chatFileService = new ChatFileService();
