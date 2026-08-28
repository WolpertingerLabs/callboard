/**
 * What each Contact Info row claims, per availability answer.
 *
 * These assertions are about honesty rather than mechanics: every branch here
 * produces a sentence the user acts on, and the expensive failure is a
 * confident wrong one ("delivered through your X connection" for a channel
 * nothing can deliver), which no build or type check would catch.
 */
import { describe, it, expect } from "vitest";
import type { UserContactAvailability } from "shared/types/index.js";
import { CONTACT_FIELDS, contactFieldState } from "./contactFields";

const field = (key: string) => CONTACT_FIELDS.find((f) => f.key === key)!;

const availability = (over: Partial<UserContactAvailability> = {}): UserContactAvailability => ({
  configured: true,
  channelsKnown: true,
  callerAlias: "default",
  channels: {
    discord: { connection: "discord-bot", available: true, providedBy: ["default"] },
    telegram: { connection: "telegram", available: false },
    email: { connection: "agentmail", available: false },
  },
  ...over,
});

describe("contactFieldState", () => {
  it("says a channel on the default caller is delivered", () => {
    const s = contactFieldState(field("discord"), availability());
    expect(s).toMatchObject({ editable: true, canEnable: true, warn: false });
    expect(s.note).toBe('Delivered through your "discord-bot" connection.');
  });

  it("names a channel carried only by an agent's credential as agent-only", () => {
    const s = contactFieldState(
      field("discord"),
      availability({ channels: { ...availability().channels, discord: { connection: "discord-bot", available: true, providedBy: ["notifier"] } } }),
    );
    expect(s.canEnable).toBe(true);
    expect(s.note).toBe('Only agents using the "notifier" credential can deliver this — ordinary chats can\'t.');
  });

  it("still calls it agent-only when there is NO default caller", () => {
    // The regression that matters: an absent callerAlias means an ordinary chat
    // gets no proxy tools at all, so this channel is agent-only in the
    // strongest sense. Reading the absence as "assume the default has it"
    // promises delivery that cannot happen.
    const s = contactFieldState(
      field("email"),
      availability({
        callerAlias: undefined,
        channels: { ...availability().channels, email: { connection: "agentmail", available: true, providedBy: ["notifier"] } },
      }),
    );
    expect(s.note).toBe('Only agents using the "notifier" credential can deliver this — ordinary chats can\'t.');
    expect(s.note).not.toMatch(/Delivered through/);
  });

  it("pluralizes when several credentials carry the channel", () => {
    const s = contactFieldState(
      field("discord"),
      availability({ channels: { ...availability().channels, discord: { connection: "discord-bot", available: true, providedBy: ["scout", "notifier"] } } }),
    );
    expect(s.note).toBe('Only agents using the "scout", "notifier" credentials can deliver this — ordinary chats can\'t.');
  });

  it("locks a channel whose connection nothing carries, and points at the fix", () => {
    const s = contactFieldState(field("telegram"), availability());
    expect(s).toMatchObject({ editable: false, canEnable: false, warn: true, missingConnection: true });
    expect(s.note).toContain('"telegram" connection');
  });

  it("locks every channel when no credential is usable, without the connection pointer", () => {
    const s = contactFieldState(field("discord"), availability({ configured: false }));
    expect(s).toMatchObject({ editable: false, canEnable: false, warn: true });
    // The fix is a credential, not a connection — the banner says so, and the
    // dashboard link must not follow this state around.
    expect(s.missingConnection).toBeUndefined();
  });

  it("does not lock a channel when a credential couldn't be checked", () => {
    // Partial failure: one credential answered, another 429'd. A channel
    // missing from the listings we DID get might live on the one we didn't —
    // locking it asserts something this answer cannot support.
    const s = contactFieldState(field("telegram"), availability({ error: "429 rate limited" }));
    expect(s).toMatchObject({ editable: true, canEnable: true });
    expect(s.missingConnection).toBeUndefined();
    expect(s.note).toMatch(/couldn't be checked just now/);
  });

  it("does not lock a channel on a stale listing", () => {
    // The core workflow: add telegram in drawlatch, come back, hit refresh,
    // the daemon 429s and the pre-add listing is served. Locking here tells
    // the user the connection they just created doesn't exist.
    const s = contactFieldState(field("telegram"), availability({ stale: true }));
    expect(s).toMatchObject({ editable: true, canEnable: true });
    expect(s.note).toMatch(/cached listing/);
  });

  it("softens the agent-only claim when the answer is incomplete", () => {
    // If the DEFAULT caller is the one that failed, providedBy can't contain
    // it — so "ordinary chats can't" is a flat negative the data doesn't
    // support. Incompleteness has to reach this branch too, or two rows make
    // claims of different confidence from the same answer.
    const s = contactFieldState(
      field("discord"),
      availability({ error: "429 rate limited", channels: { ...availability().channels, discord: { connection: "discord-bot", available: true, providedBy: ["notifier"] } } }),
    );
    expect(s).toMatchObject({ editable: true, canEnable: true });
    expect(s.note).not.toMatch(/ordinary chats can't/);
    expect(s.note).toMatch(/isn't certain/);
  });

  it("describes an agent-only channel with no named credential", () => {
    const s = contactFieldState(field("discord"), availability({ channels: { ...availability().channels, discord: { connection: "discord-bot", available: true } } }));
    expect(s.note).toBe("Only agent sessions can deliver this — ordinary chats can't.");
  });

  it("fails open when the check itself failed", () => {
    const s = contactFieldState(field("discord"), availability({ channelsKnown: false, error: "daemon unreachable" }));
    expect(s).toMatchObject({ editable: true, canEnable: true, warn: false });
    expect(s.note).toMatch(/isn't being verified/);
  });

  it("fails open before any answer has arrived", () => {
    const s = contactFieldState(field("discord"), null);
    expect(s).toMatchObject({ editable: true, canEnable: true, warn: false });
    expect(s.note).toBe(field("discord").help);
  });

  it("keeps the coming-soon field inert whatever availability says", () => {
    for (const a of [null, availability(), availability({ configured: false }), availability({ channelsKnown: false })]) {
      expect(contactFieldState(field("phone"), a)).toMatchObject({ editable: false, canEnable: false, note: "Coming soon.", warn: false });
    }
  });

  it("never produces an empty note in any reachable state", () => {
    const answers: (UserContactAvailability | null)[] = [
      null,
      availability(),
      availability({ configured: false }),
      availability({ channelsKnown: false, error: "x" }),
      availability({ callerAlias: undefined }),
      availability({ channels: { ...availability().channels, discord: { connection: "discord-bot", available: true } } }),
    ];
    for (const a of answers) {
      for (const f of CONTACT_FIELDS) {
        expect(contactFieldState(f, a).note.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("reads sensibly once prefixed for an enabled-but-undeliverable channel", () => {
    // The page prefixes with "Enabled, but not deliverable right now — " and
    // lowercases the first character; that must not maul a quoted connection.
    const s = contactFieldState(field("telegram"), availability());
    const prefixed = `Enabled, but not deliverable right now — ${s.note.charAt(0).toLowerCase()}${s.note.slice(1)}`;
    expect(prefixed).toBe('Enabled, but not deliverable right now — needs the "telegram" connection, which none of your drawlatch credentials have.');
  });
});
