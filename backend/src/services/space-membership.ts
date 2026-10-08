/**
 * Which space a chat belongs to — the one rule, shared by every listing.
 *
 * A card tree never spans two spaces, so the answer is a property of the
 * lineage ROOT, resolved the same way `archived` is (see chat-visibility.ts):
 *
 *   1. The root has a stored record → its `metadata.spaceId`, or the default
 *      when absent. Members carry their own stamp (written at spawn, so a
 *      filter over a single record is cheap), but the root's wins: a moved
 *      tree whose re-stamp half-failed still lists in one place.
 *   2. No stored root (a session discovered under ~/.claude/projects and never
 *      opened in Callboard) → the folder rules, else the default. Computed per
 *      response, never written.
 *
 * A stamp naming a space that no longer exists reads as the default, so a
 * chat can never fall out of every listing.
 */
import { ALL_SPACES, DEFAULT_SPACE_ID } from "shared";
import { parseChatMetadataRecord } from "../utils/chat-metadata.js";
import { knownSpaceIds, normalizeSpaceId, spaceForFolder } from "./space-store.js";

/** The raw `metadata.spaceId` on a record's metadata, if it is a string. */
export function spaceStampOf(meta: Record<string, unknown> | null | undefined): string | undefined {
  const value = meta?.spaceId;
  return typeof value === "string" && value ? value : undefined;
}

export interface SpaceResolver {
  /** The space `chatId`'s tree lives in. `folder` is consulted only when no stored root exists. */
  spaceOf(chatId: string, folder?: string | null): string;
  /** Does a `space=` scope admit this chat? `"all"` (or no scope) admits everything. */
  admits(scope: string | undefined, chatId: string, folder?: string | null): boolean;
}

export function createSpaceResolver<T extends { id: string; metadata?: string | null; folder?: string }>(opts: {
  existingRootIdOf: (chatId: string) => string;
  storedById: Map<string, T>;
  /** Metadata the caller already parsed, to skip a second JSON.parse per root. */
  metaOf?: (chat: T) => Record<string, unknown> | undefined;
}): SpaceResolver {
  const known = knownSpaceIds();
  const memo = new Map<string, string>();
  const spaceOfRoot = (root: T): string => {
    const cached = memo.get(root.id);
    if (cached !== undefined) return cached;
    const meta = opts.metaOf?.(root) ?? parseChatMetadataRecord(root.metadata);
    const resolved = normalizeSpaceId(spaceStampOf(meta), known);
    memo.set(root.id, resolved);
    return resolved;
  };
  const spaceOf = (chatId: string, folder?: string | null): string => {
    const rootId = opts.existingRootIdOf(chatId);
    const root = opts.storedById.get(rootId) ?? opts.storedById.get(chatId);
    if (root) return spaceOfRoot(root);
    return spaceForFolder(folder);
  };
  return {
    spaceOf,
    admits: (scope, chatId, folder) => !scope || scope === ALL_SPACES || spaceOf(chatId, folder) === scope,
  };
}

/**
 * Parse a `space` request value. `undefined` = not scoped (older bundles, plain
 * API clients); `"all"` = explicitly every space; anything else = that id,
 * unvalidated — an unknown or malformed id simply matches nothing. It must
 * never degrade to "unscoped": that would answer a typo with every space.
 */
export function parseSpaceScope(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  return raw.slice(0, 128);
}

export { DEFAULT_SPACE_ID };
