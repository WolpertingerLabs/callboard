/**
 * Server-side pieces of an aside — a child chat forked off quoted passages of
 * its parent to ask a side question (`POST /api/chats/:id/fork` with
 * `kind: "aside"`; shared shapes in `shared/types/aside.ts`).
 */
import { ASIDE_ROLE, mergePermissions, type DefaultPermissions } from "shared/types/index.js";
import { capPermissions, isPermissionAxis, isPermissionLevel } from "./permission-ceiling.js";

/**
 * Appended to the system prompt on every turn of an aside chat. Built here
 * from `chatRole`, never stored, so it applies on resume and cannot be edited
 * into something else through metadata.
 */
export const ASIDE_INSTRUCTION =
  "This chat is an aside: a side question the user is asking about passages quoted from an earlier point of the conversation above. " +
  "Answer that question. Do not continue, resume or redo the main task of the conversation, and do not make changes unless the user asks for them here.";

/**
 * {@link ASIDE_INSTRUCTION} for an aside chat's metadata, otherwise "".
 *
 * Keyed on the role alone, so ANY chat stamped `chatRole: "aside"` gets it —
 * including one spawned through `start_chat_session` with `role: "aside"`.
 * Benign: the instruction only asks for an answer rather than a continuation.
 */
export function asideInstructionFor(meta: Record<string, unknown>): string {
  return meta.chatRole === ASIDE_ROLE ? ASIDE_INSTRUCTION : "";
}

/**
 * The permissions an aside runs under. Omitted → the parent's, as a fork
 * inherits them (`null` when the parent has none, which the policy reads as
 * "ask" everywhere). Given → a partial or full set merged over the parent's
 * and then capped per axis so no axis is looser than the parent's — the
 * read-only toggle sends `{ fileWrite: "ask", codeExecution: "ask" }`.
 */
export function resolveAsidePermissions(
  parent: DefaultPermissions | null | undefined,
  requested: unknown,
): { ok: true; permissions: DefaultPermissions | null } | { ok: false; error: string } {
  if (requested === undefined) return { ok: true, permissions: parent ?? null };
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) return { ok: false, error: "permissions must be an object" };
  for (const [key, value] of Object.entries(requested)) {
    if (!isPermissionAxis(key)) return { ok: false, error: `Unknown permission category "${key}"` };
    if (!isPermissionLevel(value)) return { ok: false, error: `permissions.${key} must be one of: allow, ask, deny` };
  }
  return { ok: true, permissions: capPermissions(mergePermissions(parent, requested), parent) };
}
