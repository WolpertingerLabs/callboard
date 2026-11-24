/**
 * Whose Sandbox desktop deliverables a chat shows: its own, and — read
 * through — those of every chat its history was copied from, each up to the
 * point it was copied. Deliverables stay where they were delivered (keyed by
 * the producing chat, sandbox-deliverables.ts); nothing is moved or linked.
 *
 * A chat's history was copied from another in exactly these cases:
 *
 *  - **Continue from, Rerun, Compress** (chat-supersede.ts): the new chat N
 *    records `supersedes: { chatId: C, at, cutoff? }`. N's history is C's up
 *    to the cutoff, so N shows C's deliverables delivered by then. C, the
 *    hidden "Original", keeps showing its own.
 *  - **Forks, asides and engine switches** (the fork endpoint): `chatRole`
 *    `fork` | `aside` | `engine-switch`, `parentChatId`, `forkedAt`. They show
 *    the parent's deliverables delivered by `forkedAt`.
 *
 * Not a copy: a superseded original (`supersededBy`; its `parentChatId`
 * points at N only to place it in the tree), and ordinary child chats
 * (spawned sessions, job steps), which start with no history.
 *
 * The walk follows these links through chats that still exist, and also
 * through a deleted chat's id as recorded on a surviving one, so a deleted
 * original's deliverables keep showing in its successor (see
 * {@link sourcesKeptAlive} for when they are deleted).
 */
import { chatFileService } from "./chat-file-service.js";
import { parseChatMetadataRecord } from "../utils/chat-metadata.js";

const MAX_DEPTH = 50;
const COPY_ROLES = new Set(["fork", "aside", "engine-switch"]);

/** A chat whose deliverables are shown, and up to when (ms); `until` absent: all of them. */
export interface DeliverySource {
  chatId: string;
  until?: number;
  /** Reached through supersedes only (N in C's place): its kept sandboxes are shown and can be retried from here too. */
  replaced?: boolean;
}

type Meta = Record<string, unknown>;
export type MetaOf = (chatId: string) => Meta | undefined;
export const storedMeta: MetaOf = (chatId) => {
  const chat = chatFileService.getChat(chatId);
  return chat ? parseChatMetadataRecord(chat.metadata) : undefined;
};

const when = (value: unknown): number | undefined => {
  const ms = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

/** The chats a chat's history was copied from directly, with the copy point. */
export function copiedFrom(meta: Meta): { chatId: string; at?: number; supersede: boolean }[] {
  const out: { chatId: string; at?: number; supersede: boolean }[] = [];
  const supersedes = meta.supersedes as { chatId?: unknown; at?: unknown; cutoff?: unknown } | undefined;
  if (supersedes && typeof supersedes.chatId === "string" && supersedes.chatId)
    out.push({ chatId: supersedes.chatId, at: when(supersedes.cutoff) ?? when(supersedes.at), supersede: true });
  const parent = typeof meta.parentChatId === "string" && meta.parentChatId ? meta.parentChatId : undefined;
  if (parent && !meta.supersededBy && typeof meta.chatRole === "string" && COPY_ROLES.has(meta.chatRole))
    out.push({ chatId: parent, at: when(meta.forkedAt), supersede: false });
  return out;
}

/** The chat itself, then every chat its history was copied from, transitively, each with the earliest copy point on the way. */
export function deliverySources(chatId: string, metaOf: MetaOf = storedMeta, meta = metaOf(chatId)): DeliverySource[] {
  const result = new Map<string, DeliverySource>([[chatId, { chatId, replaced: true }]]);
  const queue: { id: string; meta?: Meta; until?: number; replaced: boolean; depth: number }[] = [{ id: chatId, meta, replaced: true, depth: 0 }];
  while (queue.length) {
    const node = queue.shift()!;
    if (!node.meta || node.depth >= MAX_DEPTH) continue;
    for (const edge of copiedFrom(node.meta)) {
      const until = node.until === undefined ? edge.at : edge.at === undefined ? node.until : Math.min(node.until, edge.at);
      const replaced = node.replaced && edge.supersede;
      const known = result.get(edge.chatId);
      if (known) {
        // Reached again: keep the widest window, and `replaced` if any path is all supersedes.
        const widest = known.until === undefined || until === undefined ? undefined : Math.max(known.until, until);
        result.set(edge.chatId, { chatId: edge.chatId, ...(widest !== undefined ? { until: widest } : {}), replaced: replaced || !!known.replaced });
        continue;
      }
      result.set(edge.chatId, { chatId: edge.chatId, ...(until !== undefined ? { until } : {}), replaced });
      queue.push({ id: edge.chatId, meta: metaOf(edge.chatId), until, replaced, depth: node.depth + 1 });
    }
  }
  return [...result.values()];
}

/**
 * For a chat being deleted: which deliverables to delete. The rule is that a
 * chat's deliverables are deleted when no surviving chat shows them any more
 * — not the deleted chat, and no chat whose history was copied from it.
 * So deleting a hidden superseded original, or the parent of a fork, keeps
 * its files while the successor or fork survives; deleting that last reader
 * then deletes them too (and any earlier deleted source only it still
 * showed).
 *
 * `sources` is the deleted chat's {@link deliverySources}, taken before its
 * record went. Returns the chat ids whose deliverables are now unreferenced.
 */
export function sourcesKeptAlive(
  deleted: string,
  sources: readonly DeliverySource[],
  exists: (chatId: string) => boolean,
  survivors: () => Iterable<{ id: string; meta: Meta }>,
  metaOf: MetaOf = storedMeta,
): { remove: string[]; keep: string[] } {
  const candidates = new Set(sources.map((s) => s.chatId).filter((id) => id === deleted || !exists(id)));
  const shown = new Set<string>();
  for (const chat of survivors()) {
    if (chat.id === deleted || !copiedFrom(chat.meta).length) continue;
    for (const source of deliverySources(chat.id, metaOf, chat.meta)) if (source.chatId !== chat.id && candidates.has(source.chatId)) shown.add(source.chatId);
  }
  return { remove: [...candidates].filter((id) => !shown.has(id)), keep: [...candidates].filter((id) => shown.has(id)) };
}
