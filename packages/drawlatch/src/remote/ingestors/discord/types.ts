/**
 * Discord-specific types and constants for the Discord Gateway ingestor.
 */

// ── Discord Gateway opcodes ─────────────────────────────────────────────

export const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

// ── Discord intent flags ────────────────────────────────────────────────

export const DiscordIntents = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MODERATION: 1 << 2,
  GUILD_EXPRESSIONS: 1 << 3,
  GUILD_INTEGRATIONS: 1 << 4,
  GUILD_WEBHOOKS: 1 << 5,
  GUILD_INVITES: 1 << 6,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15,
  GUILD_SCHEDULED_EVENTS: 1 << 16,
  AUTO_MODERATION_CONFIGURATION: 1 << 20,
  AUTO_MODERATION_EXECUTION: 1 << 21,
} as const;

/** All defined intents OR'd together (includes privileged: GUILD_MEMBERS, GUILD_PRESENCES, MESSAGE_CONTENT). */
export const ALL_INTENTS = Object.values(DiscordIntents).reduce((acc, v) => acc | v, 0);

/** All non-privileged intents OR'd together. */
export const ALL_NON_PRIVILEGED_INTENTS =
  ALL_INTENTS &
  ~(DiscordIntents.GUILD_MEMBERS | DiscordIntents.GUILD_PRESENCES | DiscordIntents.MESSAGE_CONTENT);

/** Default intents: guilds + guild messages + DMs (no privileged intents). */
export const DEFAULT_INTENTS =
  DiscordIntents.GUILDS | DiscordIntents.GUILD_MESSAGES | DiscordIntents.DIRECT_MESSAGES;

// ── Types ───────────────────────────────────────────────────────────────

export interface GatewayPayload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

// ── Close code sets ─────────────────────────────────────────────────────

/** Discord close codes that are non-recoverable (do NOT reconnect). */
export const NON_RECOVERABLE_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** Discord close codes that invalidate the session (must re-IDENTIFY, not RESUME). */
export const INVALIDATE_SESSION_CLOSE_CODES = new Set([4007, 4009]);

// ── Payload helpers ─────────────────────────────────────────────────────

/**
 * Extract a user ID from a Discord dispatch event payload.
 * Different event types store the user ID in different fields.
 */
export function extractUserId(data: Record<string, unknown>): string | undefined {
  // MESSAGE_CREATE/UPDATE: author.id
  const author = data.author as Record<string, unknown> | undefined;
  if (typeof author?.id === 'string') return author.id;
  // GUILD_MEMBER_ADD/UPDATE/REMOVE, PRESENCE_UPDATE: user.id
  const user = data.user as Record<string, unknown> | undefined;
  if (typeof user?.id === 'string') return user.id;
  // TYPING_START, MESSAGE_REACTION_ADD/REMOVE, etc.: user_id
  if (typeof data.user_id === 'string') return data.user_id;
  return undefined;
}
