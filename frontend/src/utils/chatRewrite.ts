import { ASIDE_ROLE } from "shared/types/index.js";

/**
 * The per-message actions that rewrite a chat in place: a NEW chat, made from
 * this one's history, takes its row and card, and the original is kept as the
 * new chat's child (see backend/src/services/chat-supersede.ts).
 */
export type ChatRewriteAction = "continue" | "compress-before" | "compress-after";

/**
 * Roles the original is given under the chat that replaced it. Free-form
 * strings on the wire (`ChatTreeNode.role`), so these are display knowledge,
 * not a gated enum.
 */
export const SUPERSEDED_ROLE = "superseded";
/** A side question about quoted passages (shared/types/aside.ts). */
export { ASIDE_ROLE };
export const PRE_COMPRESSION_ROLE = "pre-compression";

/**
 * Roles that branch off a message of their parent, carry a `forkedAt` and get
 * an inline marker in the parent's thread.
 */
export const BRANCH_ROLES: ReadonlySet<string> = new Set(["fork", "engine-switch", ASIDE_ROLE, SUPERSEDED_ROLE, PRE_COMPRESSION_ROLE]);
