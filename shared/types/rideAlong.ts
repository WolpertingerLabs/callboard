import type { ParsedMessage } from "./message.js";

/**
 * A ride-along notice block: computer-control updates the daemon owed the
 * agent (a withdrawn request, say), carried at the very front of the next
 * turn's user prompt because no other channel reaches every engine without
 * system authority (backend/src/services/chat-notices.ts). The engines save
 * the prompt as the human's message, so everything that shows or reuses a
 * user turn — the transcript, the in-flight match, rerun, draft restore —
 * splits the block back off with {@link splitRideAlongBlock}.
 *
 * The format is fixed end to end, and the split is strict about it, so a human
 * who types something that merely looks like it — or a parent chat or API key
 * sending a prompt built to — keeps it as the human's text. Every line must be
 * one of the fixed notice templates below, exactly, whose only variable parts
 * are a UUID, an action type, a target ({@link RIDE_ALONG_TARGETS}) and one of the
 * fixed reason and advice strings; nothing else can produce a notice row:
 *
 *     <RIDE_ALONG_HEADER>
 *     - 🖥️ Computer control update — …one line…
 *     - 🖥️ Computer control update — …one line…
 *     <RIDE_ALONG_FOOTER>
 *     <blank line, then the human's message — or nothing>
 */
export const RIDE_ALONG_HEADER = "[Callboard system notice — not typed by the human. Computer-control updates since your last turn:]";
export const RIDE_ALONG_FOOTER = "[End of Callboard notice. The human's message, if any, follows.]";
/** Every notice in a block is one line opening with this; the daemon's notice texts all start with its tail. */
export const RIDE_ALONG_NOTICE_PREFIX = "🖥️ Computer control update — ";
const LINE_PREFIX = `- ${RIDE_ALONG_NOTICE_PREFIX}`;

/**
 * Why a request was withdrawn, as the agent's notice words it, and what it is
 * told to do next. The daemon builds its withdrawal notices from these
 * (backend/src/services/computer-use.ts) and the split recognises nothing
 * else, so the two cannot drift.
 */
export const RIDE_ALONG_WITHDRAW_TEXT = {
  stopped: { agent: "the human pressed Stop", advice: "Do not request it again unless the human asks you to." },
  panelStop: { agent: "the human stopped it from the Computer view", advice: "Do not request it again unless the human asks you to." },
  revoked: { agent: "the human revoked it from the Computer view", advice: "Do not request it again unless the human asks you to." },
  scope: {
    agent: "this chat's Browser Use, Computer Use or Sandbox desktop permissions changed, or the chat was archived or deleted",
    advice: "Do not request it again unless the human asks you to.",
  },
  sessionEnded: {
    agent: "its control session ended (the 15-minute session expired, or it was stopped or revoked)",
    advice: "Check cu_open; a new session needs fresh consent through cu_request_control.",
  },
  stale: {
    agent: "the screen it was aimed at changed before the human answered (the target changed under it), so it could no longer run",
    advice: "Call cu_observe for a fresh frame, and request it again if it still makes sense.",
  },
  takeover: {
    agent: "the human took over control of the session",
    advice: "Wait until the human chooses Resume agent; then call cu_observe and request it again if it still makes sense.",
  },
  superseded: {
    agent: "the chat was rewound, forked or compressed, so this request belonged to its old history",
    advice: "Do not request it again unless the human asks you to.",
  },
  agentStop: { agent: "you stopped the session with cu_stop", advice: "" },
} as const;
export type RideAlongWithdrawReason = keyof typeof RIDE_ALONG_WITHDRAW_TEXT;

/**
 * Reason texts an older daemon wrote, still recognised so a block already in a
 * transcript keeps splitting off. Never produced: the split accepts them, the
 * daemon does not write them.
 */
const LEGACY_WITHDRAW_AGENT_TEXT: Partial<Record<RideAlongWithdrawReason, readonly string[]>> = {
  scope: ["this chat's Browser Use or Computer Use permissions changed, or the chat was archived or deleted"],
};

/**
 * The targets a notice may name, and how it names them. Enumerated rather than
 * free text, so the split below can stay strict: a target is one of these
 * exact words or the line is not a notice.
 */
export const RIDE_ALONG_TARGETS = { browser: "browser", desktop: "desktop", sandbox: "sandbox desktop" } as const;
export type RideAlongTarget = keyof typeof RIDE_ALONG_TARGETS;

/** The GUI action types a notice may name (the host's own list); anything else reads as "GUI". */
export const GUI_ACTION_TYPES = ["click", "move", "drag", "scroll", "key", "type", "navigate", "wait"] as const;

/** The first line of every Callboard notice to the agent. */
export const callboardNoticeHeader = (what: string) => `${RIDE_ALONG_NOTICE_PREFIX}${what}. (This message is from Callboard, not typed by the human.)`;

const withAdvice = (body: string, reason: RideAlongWithdrawReason) => [body, RIDE_ALONG_WITHDRAW_TEXT[reason].advice].filter(Boolean).join(" ");

/** The notice for an enable request withdrawn before the human answered. */
export function controlWithdrawnNotice(target: RideAlongTarget, requestId: string, reason: RideAlongWithdrawReason): string {
  return controlWithdrawnText(target, requestId, reason, RIDE_ALONG_WITHDRAW_TEXT[reason].agent);
}
function controlWithdrawnText(target: RideAlongTarget, requestId: string, reason: RideAlongWithdrawReason, why: string): string {
  const noun = RIDE_ALONG_TARGETS[target];
  const body = `Your request ${requestId} to enable ${noun} control was withdrawn, and control was NOT enabled: ${why}.`;
  return `${callboardNoticeHeader(`${noun} control request withdrawn`)}\n\n${withAdvice(body, reason)}`;
}

/** The notice for a GUI action withdrawn before the human answered. An `actionType` outside {@link GUI_ACTION_TYPES} reads as "GUI". */
export function actionWithdrawnNotice(actionType: string, requestId: string, reason: RideAlongWithdrawReason): string {
  return actionWithdrawnText(actionType, requestId, reason, RIDE_ALONG_WITHDRAW_TEXT[reason].agent);
}
function actionWithdrawnText(actionType: string, requestId: string, reason: RideAlongWithdrawReason, why: string): string {
  const type = (GUI_ACTION_TYPES as readonly string[]).includes(actionType) ? actionType : "GUI";
  const body = `Your request ${requestId} (a ${type} action) was withdrawn before the human answered, and it was NOT performed: ${why}.`;
  return `${callboardNoticeHeader("GUI action request withdrawn")}\n\n${withAdvice(body, reason)}`;
}

/** The `subtype` of the system row a split-off block renders as. */
export const CALLBOARD_NOTICE_SUBTYPE = "callboard_notice";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const flatten = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/**
 * Every line a block may hold: each withdrawal template, flattened as it is in
 * a block, with its variable parts narrowed to the only values they can take
 * — a UUID request id, a GUI action type. The target and the reason are
 * enumerated, so they are literal text here.
 */
const NOTICE_LINES: readonly RegExp[] = (() => {
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const ID = "00000000-0000-0000-0000-000000000000";
  const types = `(?:${[...GUI_ACTION_TYPES, "GUI"].join("|")})`;
  const lines = new Set<string>();
  for (const reason of Object.keys(RIDE_ALONG_WITHDRAW_TEXT) as RideAlongWithdrawReason[]) {
    for (const why of [RIDE_ALONG_WITHDRAW_TEXT[reason].agent, ...(LEGACY_WITHDRAW_AGENT_TEXT[reason] ?? [])]) {
      for (const target of Object.keys(RIDE_ALONG_TARGETS) as RideAlongTarget[])
        lines.add(escape(flatten(controlWithdrawnText(target, ID, reason, why))).replaceAll(ID, UUID));
      lines.add(
        escape(flatten(actionWithdrawnText("GUI", ID, reason, why)))
          .replaceAll(ID, UUID)
          .replace("\\(a GUI action\\)", `\\(a ${types} action\\)`),
      );
    }
  }
  return [...lines].map((line) => new RegExp(`^${line}$`, "u"));
})();

/** Is `line` (a block line without its "- ") exactly one of the daemon's fixed notice templates? */
export function isRideAlongNoticeLine(line: string): boolean {
  return NOTICE_LINES.some((pattern) => pattern.test(line));
}

const BLOCK = new RegExp(`^${escape(RIDE_ALONG_HEADER)}\\n((?:${escape(LINE_PREFIX)}[^\\r\\n]+\\n)+)${escape(RIDE_ALONG_FOOTER)}(?:\\n\\n([\\s\\S]*))?$`, "u");

/** Build the block for `notices` (each flattened to one line, prefixed if it is not already). */
export function formatRideAlongBlock(notices: readonly string[]): string {
  const lines = notices.map((text) => {
    const flat = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
    return `- ${flat.startsWith(RIDE_ALONG_NOTICE_PREFIX) ? flat : `${RIDE_ALONG_NOTICE_PREFIX}${flat}`}`;
  });
  return [RIDE_ALONG_HEADER, ...lines, RIDE_ALONG_FOOTER].join("\n");
}

/**
 * Split a ride-along block off the start of a user message: the notices it
 * carried (one per line, prefix kept) and the human's own text after it ("" if
 * none). Null unless `content` opens with a block in exactly the fixed format
 * — at offset 0, not after whitespace; fixed header, ≥1 lines each exactly a
 * fixed notice template ({@link isRideAlongNoticeLine}), fixed footer; then
 * the end, or a blank line and the rest.
 */
export function splitRideAlongBlock(content: string): { notices: string[]; rest: string } | null {
  const match = BLOCK.exec(content);
  if (!match) return null;
  const notices = match[1]
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(2));
  // Anyone can write the header and footer — a parent chat's prompt, an
  // API-key send. Only the daemon's own templates make a notice row; one
  // line that is anything else leaves the whole message the human's.
  if (!notices.every(isRideAlongNoticeLine)) return null;
  return { notices, rest: match[2] ?? "" };
}

/**
 * The transcript with every ride-along block taken out of the human's message
 * and shown as its own system row just before it, so the human sees what the
 * agent was told without it reading as their own words. A block that was the
 * whole message (a multimodal prompt carries it as its own text block) becomes
 * just the row.
 */
export function splitRideAlongMessages(messages: readonly ParsedMessage[]): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  for (const message of messages) {
    const split = message.role === "user" && message.type === "text" ? splitRideAlongBlock(message.content ?? "") : null;
    if (!split) {
      out.push(message);
      continue;
    }
    out.push({
      role: "system",
      type: "system",
      subtype: CALLBOARD_NOTICE_SUBTYPE,
      content: split.notices.join("\n"),
      ...(message.timestamp !== undefined && { timestamp: message.timestamp }),
    });
    if (split.rest.trim() || message.imageIds?.length) out.push({ ...message, content: split.rest });
  }
  return out;
}

/** A user message's text with any leading ride-along block removed (unchanged when there is none). */
export function withoutRideAlongBlock(content: string): string {
  return splitRideAlongBlock(content)?.rest ?? content;
}
