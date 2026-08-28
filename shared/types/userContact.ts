/** A single contact channel: the handle/value and whether it's active. */
export interface ContactChannel {
  /** The contact handle (e.g. Discord username, Telegram handle, email, phone number). */
  value: string;
  /** Whether the agent is allowed to reach the user through this channel. */
  enabled: boolean;
}

/**
 * The user's contact info, used by the notify_user callboard tool to decide
 * which channel(s) the agent may use to reach the user via drawlatch.
 *
 * `phone` is stored but is a future feature — it is never offered to the agent.
 */
export interface UserContactInfo {
  discord: ContactChannel;
  telegram: ContactChannel;
  phone: ContactChannel;
  email: ContactChannel;
}

/** Channel keys that notify_user can dispatch to (phone excluded). */
export type NotifiableChannel = "discord" | "telegram" | "email";

/**
 * The drawlatch connection each notifiable channel is delivered through.
 *
 * Single-sourced because two places have to agree: `notify_user` tells the
 * agent which connection to reach for, and Settings → General offers the
 * channel only when that same connection exists on the default caller. If they
 * drift, the settings page offers a channel the tool then cannot deliver on.
 */
export const CONTACT_CHANNEL_CONNECTIONS: Record<NotifiableChannel, string> = {
  discord: "discord-bot",
  telegram: "telegram",
  email: "agentmail",
};

/** Whether one channel's connection is present on some usable caller. */
export interface ContactChannelAvailability {
  /** The drawlatch connection this channel needs. */
  connection: string;
  /** Whether that connection appears in any usable caller's route listing. */
  available: boolean;
  /**
   * Caller aliases carrying the connection, default caller first. Absent when
   * unavailable. A channel present only on an agent-bound caller is usable by
   * that agent's sessions but not by regular ones — the UI says which.
   */
  providedBy?: string[];
}

/**
 * Which contact channels this instance's drawlatch callers can deliver on.
 *
 * Read by Settings → General to decide which contact channels may be switched
 * on. Three flags carry three genuinely different answers, and collapsing any
 * two of them produces a wrong UI:
 *
 *   - `configured: false` — determinate. No usable caller exists at all, so
 *     nothing can be delivered.
 *   - `channelsKnown: false` — INDETERMINATE. No caller's listing could be
 *     read, so `channels` is not an answer. Consumers must fail OPEN; "not
 *     connected" and "couldn't ask" are different, and only the first
 *     justifies taking the user's controls away.
 *   - `error` set with `channelsKnown: true` — partial. At least one listing
 *     was read and `channels` is trustworthy, but another caller failed. Gate
 *     on it, and tell the user the picture may be incomplete.
 */
export interface UserContactAvailability {
  /** True when at least one usable caller is configured. */
  configured: boolean;
  /** True when `channels` reflects a real listing rather than a failed check. */
  channelsKnown: boolean;
  /** The default caller's alias, when one is configured. */
  callerAlias?: string;
  /** True when a listing was served from cache after a failed live fetch. */
  stale?: boolean;
  /** Set when any caller's listing could not be read. */
  error?: string;
  /** Per-channel availability. Phone is excluded — it has no connection. */
  channels: Record<NotifiableChannel, ContactChannelAvailability>;
}
