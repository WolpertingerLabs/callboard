import type { NotifiableChannel, UserContactAvailability, UserContactInfo } from "shared/types/index.js";

/**
 * The Contact Info rows in Settings → General, and the rule deciding what each
 * one may do against the availability answer from
 * `GET /api/user-contact/availability`.
 *
 * Extracted from the page because this is where the user-visible claims are
 * decided — "delivered through your discord-bot connection" vs "only agents
 * using notifier can deliver this" — and a wrong claim here is silent. It
 * doesn't crash or fail a build; the user simply believes a channel works,
 * enables it, walks away, and no message arrives.
 */

export type ContactKey = keyof UserContactInfo;

export interface ContactField {
  key: ContactKey;
  label: string;
  placeholder: string;
  help: string;
  /** The notify_user channel this field feeds; absent ⇒ never deliverable. */
  channel?: NotifiableChannel;
  /** Stored, but not yet a real channel — always off. */
  comingSoon?: boolean;
}

export const CONTACT_FIELDS: ContactField[] = [
  {
    key: "discord",
    label: "Discord username",
    placeholder: "username",
    help: "Needs a Discord connection on your drawlatch credential.",
    channel: "discord",
  },
  {
    key: "telegram",
    label: "Telegram account",
    placeholder: "@handle",
    help: "Needs a Telegram connection on your drawlatch credential.",
    channel: "telegram",
  },
  { key: "phone", label: "Phone number", placeholder: "+1 555 123 4567", help: "Coming soon.", comingSoon: true },
  {
    key: "email",
    label: "Email address",
    placeholder: "you@example.com",
    help: "Needs the AgentMail connection on your drawlatch credential.",
    channel: "email",
  },
];

/** A blank contact record, used until the stored one loads. */
export function emptyContact(): UserContactInfo {
  return {
    discord: { value: "", enabled: false },
    telegram: { value: "", enabled: false },
    phone: { value: "", enabled: false },
    email: { value: "", enabled: false },
  };
}

/** What a contact field may do, and what to say beneath it. */
export interface ContactFieldState {
  /** May the handle be typed? False only for a channel nothing can deliver. */
  editable: boolean;
  /** May the channel be switched ON? Switching OFF is always permitted. */
  canEnable: boolean;
  note: string;
  warn: boolean;
  /**
   * True only when the fix is "add this connection in drawlatch" — which is
   * where the dashboard link is worth showing. A missing *credential* is a
   * different fix (Settings → Proxy), so the banner handles that one and the
   * link must not follow it around.
   */
  missingConnection?: boolean;
}

/**
 * Resolve one contact field against the availability answer.
 *
 * Three rules do all the work here, and each one is about not overstating what
 * we know:
 *
 * 1. **Fail open when the check failed.** No answer yet, or `channelsKnown:
 *    false`, leaves the field fully usable. "Not connected" and "couldn't ask"
 *    are different, and only the first justifies taking controls away.
 * 2. **Switching a channel OFF is never gated.** A handle enabled while its
 *    connection existed stays enabled if that connection disappears, and
 *    `notify_user` will still dispatch on it — so the one control that fixes
 *    the problem must not be disabled by the same condition that reports it.
 * 3. **A channel only an agent's credential carries is said to be exactly
 *    that.** An ordinary chat borrows the default caller and nothing else, so
 *    when the connection isn't on the default caller — including when there is
 *    no default caller at all, where an ordinary chat gets no proxy tools
 *    whatsoever — calling it "delivered" would be a false promise.
 */
export function contactFieldState(field: ContactField, availability: UserContactAvailability | null): ContactFieldState {
  if (field.comingSoon) return { editable: false, canEnable: false, note: field.help, warn: false };

  if (!field.channel || !availability) {
    return { editable: true, canEnable: true, note: field.help, warn: false };
  }

  if (!availability.channelsKnown) {
    return { editable: true, canEnable: true, note: `${field.help} Couldn't check your connections just now, so this isn't being verified.`, warn: false };
  }

  // No usable credential at all — every channel is dark for one shared reason,
  // so the section banner carries the explanation and the field stays terse.
  if (!availability.configured) {
    return { editable: false, canEnable: false, note: "Unavailable until a drawlatch credential is set up.", warn: true };
  }

  const entry = availability.channels[field.channel];
  if (!entry?.available) {
    // Rule 1 again, at per-credential granularity: when some credential
    // couldn't be reached, "not in the listing" might only mean "not in the
    // listing we got". A determinate lock needs a complete answer, or one
    // flaky credential among several locks every channel only it provides.
    if (availability.error) {
      return {
        editable: true,
        canEnable: true,
        note: `Needs the "${entry?.connection ?? field.channel}" connection. One of your credentials couldn't be checked just now, so this isn't certain.`,
        warn: false,
      };
    }
    return {
      editable: false,
      canEnable: false,
      note: `Needs the "${entry?.connection ?? field.channel}" connection, which none of your drawlatch credentials have.`,
      warn: true,
      missingConnection: true,
    };
  }

  // Note the leading `!!callerAlias`: an absent alias means there is no default
  // caller, which makes the channel MORE agent-only, not less. Reading it as
  // "we don't know, so assume the default has it" is the one inversion that
  // turns this whole feature into a confident false promise.
  const onDefault = !!availability.callerAlias && !!entry.providedBy?.includes(availability.callerAlias);
  if (!onDefault) {
    const credentials = entry.providedBy ?? [];
    const named = credentials.map((a) => `"${a}"`).join(", ");
    return {
      editable: true,
      canEnable: true,
      note: named
        ? `Only agents using the ${named} ${credentials.length === 1 ? "credential" : "credentials"} can deliver this — ordinary chats can't.`
        : "Only agent sessions can deliver this — ordinary chats can't.",
      warn: false,
    };
  }

  return { editable: true, canEnable: true, note: `Delivered through your "${entry.connection}" connection.`, warn: false };
}
