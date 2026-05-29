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
