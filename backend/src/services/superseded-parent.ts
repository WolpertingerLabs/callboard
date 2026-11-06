/**
 * Which chat answers for a child's permission prompt when the child's stored
 * parent has been superseded (chat-supersede.ts).
 *
 * A child left under a superseded original C still names C as its parent —
 * the tree is right to: C is the conversation that spawned it. But the user
 * now works in N, the chat that took C's place, so a prompt the child offers
 * its parent (`parentAnswers`) should reach N, which can answer it, rather
 * than C, which nobody is looking at.
 *
 * The rule mirrors how supersede moves pending callbacks: a compression keeps
 * the whole conversation, so its N always answers; a continue-from's (or a
 * rerun's) N ends at the cutoff, so it answers only for children that existed by then — a child
 * started later belongs to the branch that went on, which is C.
 *
 * Deliberately standalone — chatFileService only — so claude.ts can import it
 * without closing a cycle through chat-lineage.
 */
import { chatFileService } from "./chat-file-service.js";
import { parseChatMetadataRecord } from "../utils/chat-metadata.js";

/** A chain of supersedes is followed this far, then the last chat reached answers. */
const MAX_HOPS = 10;

/**
 * Follow `parentId`'s `supersededBy` links to the chat that should answer for a
 * child created at `childCreatedAt` (ISO; absent = unknown, treated as old
 * enough). Returns `parentId` itself when it was never superseded, or when the
 * successor no longer exists.
 */
export function answeringParentFor(parentId: string, childCreatedAt: string | undefined): string {
  const childMs = childCreatedAt ? new Date(childCreatedAt).getTime() : NaN;
  let current = parentId;
  const seen = new Set<string>([parentId]);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const record = chatFileService.getChat(current);
    if (!record) return current;
    const meta = parseChatMetadataRecord(record.metadata);
    const by = meta.supersededBy as { chatId?: unknown; kind?: unknown; cutoff?: unknown } | undefined;
    const next = typeof by?.chatId === "string" ? by.chatId : undefined;
    if (!next || seen.has(next) || !chatFileService.getChat(next)) return current;
    if (by?.kind === "continue" || by?.kind === "rerun") {
      // N ends at the recorded cutoff (a rerun's: just before its prompt),
      // else at C's forkedAt.
      const cutoff = typeof by.cutoff === "string" ? by.cutoff : meta.forkedAt;
      const cutoffMs = typeof cutoff === "string" ? new Date(cutoff).getTime() : NaN;
      if (!isNaN(childMs) && !isNaN(cutoffMs) && childMs > cutoffMs) return current;
    }
    seen.add(next);
    current = next;
  }
  return current;
}
