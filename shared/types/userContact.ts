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

/** Whether one channel's connection is present on the default caller. */
export interface ContactChannelAvailability {
  /** The drawlatch connection this channel needs. */
  connection: string;
  /** Whether that connection appears in the default caller's route listing. */
  available: boolean;
}

/**
 * Which contact channels the default drawlatch caller can actually deliver on.
 *
 * Read by Settings → General to enable or disable each contact field. The two
 * negative answers are not the same and must not be collapsed:
 *
 *   - `configured: false` — determinate. There is no default caller (or its
 *     keys are unusable), so no channel can be delivered on, full stop.
 *   - `error` set — indeterminate. The daemon couldn't be asked, so nothing is
 *     known. Consumers fail OPEN here; a daemon hiccup must not lock the user
 *     out of editing their own contact info.
 */
export interface UserContactAvailability {
  /** True when a default caller is configured and its routes could be read. */
  configured: boolean;
  /** The default caller alias the listing came from, when there is one. */
  callerAlias?: string;
  /** True when the listing is a cached one served after a failed refresh. */
  stale?: boolean;
  /** Set when the routes could not be read — availability is unknown. */
  error?: string;
  /** Per-channel availability. Phone is excluded — it has no connection. */
  channels: Record<NotifiableChannel, ContactChannelAvailability>;
}
