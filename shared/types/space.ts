import type { DefaultPermissions } from "./permissions.js";
import type { EffortLevel, UiAgentProviderKind } from "./providers.js";

/**
 * Spaces — named partitions of the chat list ("Work", "Personal", …).
 *
 * A space is OWNED state, like a workspace and unlike a directory: it is a
 * label that belongs to a card tree, never something derived from `cwd`. One
 * folder can have chats in several spaces, and git state for that folder is
 * the same in all of them (see "Workspace keying" in .claude/CLAUDE.md).
 *
 * A chat names its space with `metadata.spaceId`. An absent value means
 * {@link DEFAULT_SPACE_ID}, so chats that predate the feature need no
 * migration. A card tree never spans two spaces: the lineage ROOT's value is
 * authoritative, members are stamped at spawn only so they can be filtered
 * cheaply. Discovered sessions with no chat record resolve through
 * {@link Space.folderRules}, computed per response and never written.
 */

/** The space every chat without a `metadata.spaceId` belongs to. Shown as "General". */
export const DEFAULT_SPACE_ID = "default";
/** Display name of the default space until the user renames it. */
export const DEFAULT_SPACE_NAME = "General";
/** The listing scope that spans every space. Never a space id. */
export const ALL_SPACES = "all";

export const SPACE_NAME_MAX = 64;
/** Cap on per-space instructions appended to every chat's system prompt. */
export const SPACE_INSTRUCTIONS_MAX = 4000;
export const SPACE_FOLDER_RULES_MAX = 50;

/**
 * Accent tints a space may pick. Token NAMES, not colours: each maps to a CSS
 * custom property (`--space-accent-<name>`), so every theme decides what the
 * tint looks like and no literal ever reaches a component.
 */
export const SPACE_ACCENTS = ["blue", "green", "purple", "orange", "pink", "teal"] as const;
export type SpaceAccent = (typeof SPACE_ACCENTS)[number];

/** Recent folder entry, same shape the global new-chat settings keep. */
export interface SpaceRecentDirectory {
  path: string;
  lastUsed: string;
}

/**
 * New-chat defaults for a space. Every field is optional: an unset field falls
 * back to the global value the browser keeps in localStorage, so a space with
 * no defaults behaves exactly like Callboard did before spaces.
 */
export interface SpaceDefaults {
  provider?: UiAgentProviderKind;
  /** Model for the chosen provider, in that provider's vocabulary. */
  model?: string;
  effort?: EffortLevel;
  defaultPermissions?: DefaultPermissions;
  worktreeByDefault?: boolean;
  /** Most recent first; capped server-side. */
  recentDirectories?: SpaceRecentDirectory[];
}

/**
 * Which app plugins (MCP servers included) and custom skills load in this
 * space's chats. Each list is an allowlist when present; absent means
 * "everything enabled globally", so the default is no restriction.
 */
export interface SpaceAgentScope {
  /** App plugin ids. */
  plugins?: string[];
  /** Custom skill names (as listed in Settings → Skills). */
  skills?: string[];
}

export interface Space {
  /** Opaque. `"default"` is reserved; generated ids look like `sp_…`. */
  id: string;
  name: string;
  emoji?: string;
  /** Accent token name — see {@link SPACE_ACCENTS}. Never a colour literal. */
  color?: SpaceAccent;
  /** Ascending sort order in the switcher. */
  order: number;
  archived?: boolean;
  /**
   * Folder globs (`~/work/**`, or a plain directory meaning "it and below").
   * They pick the space for a NEW chat created without one, and for a
   * discovered session with no chat record. They never re-file a chat that
   * already has a space.
   */
  folderRules?: string[];
  defaults?: SpaceDefaults;
  /** Appended to the system prompt of every regular chat in the space. */
  instructions?: string;
  agentScope?: SpaceAgentScope;
  createdAt: string;
  updatedAt: string;
}

/**
 * Body of `POST /api/spaces` and `PATCH /api/spaces/:id`. PATCH is a delta:
 * absent keys are left alone and `null` clears an optional field, so two tabs
 * editing different fields never overwrite each other.
 */
export interface SpacePatch {
  name?: string;
  emoji?: string | null;
  color?: SpaceAccent | null;
  order?: number;
  archived?: boolean;
  folderRules?: string[] | null;
  /** Merged key by key; a `null` value clears that default. */
  defaults?: { [K in keyof SpaceDefaults]?: SpaceDefaults[K] | null } | null;
  instructions?: string | null;
  /**
   * Replaces a list wholesale — for turning a restriction on or off. Editing
   * a single entry uses the add/remove deltas below instead.
   */
  agentScope?: { plugins?: string[] | null; skills?: string[] | null } | null;
  /**
   * Delta operations, applied to the server's CURRENT copy rather than to a
   * list the client read earlier — so a tab removing one entry can never drop
   * an entry another tab (or the server itself) added in the meantime.
   */
  removeRecentDirectory?: string;
  /** Append folder rules (deduped) without replacing the list another tab may have edited. */
  folderRulesAdd?: string[];
  /** Add entries to a restricted list. A list that is unrestricted stays so (it already admits everything). */
  agentScopeAdd?: { plugins?: string[]; skills?: string[] };
  /** Remove entries from a restricted list. An unrestricted list is left unrestricted. */
  agentScopeRemove?: { plugins?: string[]; skills?: string[] };
}

/** One row of `GET /api/spaces`. */
export interface SpaceListItem extends Space {
  /** Stored chats whose tree resolves to this space. 0 unless counts were requested. */
  chatCount: number;
  /** Job definitions whose `defaults.spaceId` names this space. Only with counts. */
  jobCount?: number;
}

export interface SpaceListResponse {
  spaces: SpaceListItem[];
}

/** `?space=` value: a space id, or {@link ALL_SPACES}. */
export type SpaceScope = string;

/** Is this a usable `space` scope value (an id shape or "all")? */
export function isSpaceScope(value: unknown): value is SpaceScope {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value);
}
