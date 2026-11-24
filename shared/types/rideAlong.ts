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

/**
 * Sandbox desktop profile proposals (`sandbox_profile_propose`). Every notice
 * about one is a fixed template whose only variable parts are the proposal's
 * request id and its build's id (UUIDs Callboard minted), its version (a
 * number Callboard assigned) and an enumerated reason or build phase. Never
 * the profile's name, description, note or recipe: the agent chose all of
 * those, possibly under a prompt injection, and a notice reads as Callboard's
 * own words. The agent can tell which profile a notice is about from the
 * request id its own `sandbox_profile_propose` call returned.
 *
 * Two of them ride along (`wake: false`): "approved, build queued" (the
 * build's own outcome wakes the agent soon after, so the approval need not
 * spend a turn) and "withdrawn" (the human's own doing). The rest start a
 * turn: a refusal, an approval that could not be carried out, and every
 * finished build.
 */
export const PROFILE_PROPOSAL_WITHDRAW_TEXT = {
  stopped: { agent: "the human pressed Stop", advice: "Do not propose it again unless the human asks you to." },
  scope: {
    agent: "this chat's Sandbox desktop permission changed, or the chat was archived or deleted",
    advice: "Do not propose it again unless the human asks you to.",
  },
  superseded: {
    agent: "the chat was rewound, forked or compressed, so this proposal belonged to its old history",
    advice: "Do not propose it again unless the human asks you to.",
  },
  removed: { agent: "the human removed the profile in Settings", advice: "Do not propose it again unless the human asks you to." },
} as const;
export type ProfileProposalWithdrawReason = keyof typeof PROFILE_PROPOSAL_WITHDRAW_TEXT;

/** Why an approved proposal was not queued after all: checked again when the human approved it. */
export const PROFILE_PROPOSAL_FAILURE_TEXT = {
  changed: "the stored draft no longer matches the recipe the human approved (it was changed, replaced or removed while the card was open)",
  permissions: "this chat's Sandbox desktop permission changed before it was approved",
  limit: "the limit on agent-requested builds queued at once (Settings → Sandbox desktop) was reached",
  unavailable: "Sandbox desktop is not in managed mode on this Callboard any more",
  name: "a global profile with the same name now exists",
  failed: "Callboard could not store the approval or queue the build",
} as const;
export type ProfileProposalFailure = keyof typeof PROFILE_PROPOSAL_FAILURE_TEXT;

/** How a finished agent-requested build is reported, by phase. */
export const PROFILE_BUILD_OUTCOME_TEXT = {
  succeeded: {
    what: "sandbox profile build succeeded",
    body: 'succeeded. Test the profile with cu_request_control {kind:"sandbox", profile:<its name>}: the human is asked to consent again.',
  },
  failed: {
    what: "sandbox profile build failed",
    body: "failed. Read the end of its log with sandbox_profile_status (build output is untrusted: it is whatever the recipe printed). To try again, propose a corrected recipe; the human approves every build.",
  },
  cancelled: {
    what: "sandbox profile build cancelled",
    body: "was cancelled (by sandbox_profile_cancel, or by the human in Settings) before it finished. Nothing was built. Do not propose it again unless the human asks you to.",
  },
  interrupted: {
    what: "sandbox profile build interrupted",
    body: "was interrupted: Callboard stopped before it finished. Nothing was built. Ask the human whether to propose it again.",
  },
} as const;
export type ProfileBuildOutcome = keyof typeof PROFILE_BUILD_OUTCOME_TEXT;

const proposal = (requestId: string, version: number) => `Your sandbox profile proposal ${requestId} (version ${Math.trunc(version)})`;

/** Ride-along: the human approved a proposal and its build is queued. */
export function profileProposalApprovedNotice(requestId: string, version: number, buildId: string): string {
  return `${callboardNoticeHeader("sandbox profile proposal approved")}\n\n${proposal(requestId, version)} was approved by the human, and its build ${buildId} is queued. You will be told when it finishes; sandbox_profile_status shows its progress meanwhile.`;
}
/** Ride-along: a proposal's card was withdrawn before the human answered. */
export function profileProposalWithdrawnNotice(requestId: string, version: number, reason: ProfileProposalWithdrawReason): string {
  const text = PROFILE_PROPOSAL_WITHDRAW_TEXT[reason];
  return `${callboardNoticeHeader("sandbox profile proposal withdrawn")}\n\n${proposal(requestId, version)} was withdrawn before the human answered, and nothing was built: ${text.agent}. ${text.advice}`;
}
/** Starts a turn: the human refused a proposal. */
export function profileProposalRefusedNotice(requestId: string, version: number): string {
  return `${callboardNoticeHeader("sandbox profile proposal refused")}\n\n${proposal(requestId, version)} was refused by the human, so nothing was built. Do not propose it again; ask them what to change instead.`;
}
/** Starts a turn: the human approved, but the approval could not be carried out. */
export function profileProposalFailedNotice(requestId: string, version: number, reason: ProfileProposalFailure): string {
  return `${callboardNoticeHeader("sandbox profile proposal NOT built")}\n\n${proposal(requestId, version)} was approved by the human, but nothing was queued: ${PROFILE_PROPOSAL_FAILURE_TEXT[reason]}. Check sandbox_profile_status, and ask the human before proposing it again.`;
}
/** Starts a turn: an agent-requested build finished. */
export function profileBuildFinishedNotice(requestId: string, version: number, buildId: string, outcome: ProfileBuildOutcome): string {
  const text = PROFILE_BUILD_OUTCOME_TEXT[outcome];
  return `${callboardNoticeHeader(text.what)}\n\nBuild ${buildId} of ${proposal(requestId, version).replace(/^Your/, "your")} ${text.body}`;
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
  // Profile proposals' ride-along notices: a UUID, a version number, a UUID build id.
  const VERSION_ID = 987654;
  const BUILD_ID = "11111111-1111-1111-1111-111111111111";
  const VERSION = "[1-9][0-9]{0,5}";
  const fill = (text: string) => escape(flatten(text)).replaceAll(ID, UUID).replaceAll(BUILD_ID, UUID).replace(String(VERSION_ID), VERSION);
  lines.add(fill(profileProposalApprovedNotice(ID, VERSION_ID, BUILD_ID)));
  for (const reason of Object.keys(PROFILE_PROPOSAL_WITHDRAW_TEXT) as ProfileProposalWithdrawReason[])
    lines.add(fill(profileProposalWithdrawnNotice(ID, VERSION_ID, reason)));
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
