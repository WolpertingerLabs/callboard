/** Thin Callboard host: policy, human grants and presentation. Drivers live in the independent package. */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
// The schema is a value, not a type: `describeAgentActionForLog` asks the
// service's own grammar whether an action is well-formed before it writes a
// word about it. The package's index pulls in zod and node builtins only —
// playwright is a type-only import inside the browser driver — so this costs
// nothing that the dynamic import in `getComputerUseHost` was avoiding.
import { actionSchema } from "@wolpertingerlabs/computer-use";
import type { Action, AuthorizationRequest, ComputerUseService, Driver, Lease, Principal, SessionStatus } from "@wolpertingerlabs/computer-use";
import { CU_ACTION_TOOL_NAME, CU_REQUEST_CONTROL_TOOL_NAME } from "shared/types/index.js";
import { assertNativeAgentControllable } from "./codex-native-agents.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { createLogger } from "../utils/logger.js";
import { resolveSessionContext } from "../utils/session-provenance.js";
import { chatFileService } from "./chat-file-service.js";
import { computerUseScopeError, readComputerUsePolicy, type ComputerTargetKind, type ComputerUsePolicy } from "./computer-use-policy.js";
import { sessionRegistry } from "./session-registry.js";
import { getPendingRequest, requestHumanApproval, type HumanApprovalOutcome, type ApprovalCompletion } from "./pending-requests.js";

const log = createLogger("computer-use");

/**
 * Codes the host or the driver package raises to tell a caller what to do
 * differently: a chat that does not exist, a malformed action, a stale frame,
 * an approval the human has not given yet, a turn that moved on. They are the
 * control plane working, so they log at debug — a viewer clicking against an
 * old frame would otherwise fill the log with `stale_frame` at error level.
 *
 * `denied` is deliberately *not* here; see the level table in
 * `logComputerUseFailure`.
 */
const ROUTINE_CONTROL_CODES = new Set([
  "not_found",
  "invalid_request",
  "approval_required",
  // The two ways a GUI action ends without the human ever saying yes: nobody
  // answered the chat prompt in time, and there was nowhere to ask (no live
  // session, or the chat's one prompt slot was already occupied). Neither is a
  // fault — an operator who wants them raises the level. They are emphatically
  // NOT the escalated case, which is a human answering yes and it still not
  // happening; see `markConfirmedFailure`.
  "approval_timeout",
  "approval_unavailable",
  "queue_full",
  "lease_conflict",
  "stale_frame",
  "stale_generation",
  "stopped",
  "revoked",
  "cancelled",
]);

/** Identifiers are caller-supplied; keep them to the id alphabet so nothing forges a log line. */
const controlId = (value: unknown): string => (typeof value === "string" ? value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160) : "");

/** The `chat=… session=…` prefix every computer-control log line shares. */
const controlIds = (ids: { chatId?: unknown; sessionId?: unknown }): string => {
  const sessionId = controlId(ids.sessionId);
  return `chat=${controlId(ids.chatId) || "-"}${sessionId ? ` session=${sessionId}` : ""}`;
};

/**
 * An error's `code`, sanitized. Same treatment as the identifiers: a code can
 * reach here from a recovered MCP payload, so bound it and drop anything that
 * could act as a separator. The alphabet stays wide enough for an errno
 * (`ENOENT`, `ERR_DLOPEN_FAILED`), which is the most greppable thing an uncoded
 * throwable carries. Empty when there is no string code — the caller decides
 * what that means.
 */
const controlCode = (error: unknown): string => {
  const raw = (error as { code?: unknown } | null | undefined)?.code;
  return typeof raw === "string" ? raw.slice(0, 64).replace(/[^a-zA-Z0-9_]/g, "") : "";
};

/**
 * The code inside an `isError` tool result, which is not a throw and carries no
 * `code` property of its own.
 *
 * Reading it keeps the unattended correction line honest about *why* an action
 * did not complete instead of labelling everything `unavailable`. Exactly the
 * classification `mcpFailure` makes on the tool side, and for the same two
 * cases it documents: our own handler's `{"error":"<code>"}` envelope
 * (`mcp.ts`, a fixed enum), or the SDK's own argument validation, which is not
 * JSON and is an `invalid_request` — `cu_action`'s outer schema is a loose
 * record, so an action can pass it and fail the strict `computer_act` one.
 * Anything else yields "", and the caller falls back.
 */
const envelopeCode = (result: unknown): string => {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return "";
  const block = content.find((item) => (item as { type?: unknown } | null)?.type === "text") as { text?: unknown } | undefined;
  if (typeof block?.text !== "string" || !block.text) return "";
  try {
    return controlCode({ code: (JSON.parse(block.text) as { error?: unknown }).error });
  } catch {
    return "invalid_request";
  }
};

/**
 * An abort is not a fault, and it does not always arrive as `cancelled`: the
 * MCP client rejects an aborted call with a numeric `-32001` McpError, and a
 * DOMException abort carries the numeric `code` 20. Callers that hold the
 * signal say so explicitly (`context.cancelled`), because `-32001` is also the
 * SDK's *timeout*, which is a genuine fault and must stay at error.
 */
const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || (error as { code?: unknown }).code === 20 || (error as { code?: unknown }).code === "ABORT_ERR");

/**
 * Fold anything that could end a line or move the cursor into a space. Covers
 * C0 and C1 (`\p{Cc}`, which includes NEL) and the format characters, plus the
 * two Unicode separators outside those classes: `less` ignores U+2028, but CSS
 * `white-space: pre` treats it as a forced break, so a log rendered in a
 * browser would show it as one.
 */
const oneLine = (value: string): string => value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ");

/**
 * The frames of an error, with the `Name: message` header removed.
 *
 * The header is dropped by *length*, not by taking everything after the first
 * newline: a message can itself contain `\n    at forged (/evil.js:1:1)`, and
 * that survives a per-line frame filter looking like the innermost call site.
 * Slicing the message out of the stack removes the whole region it controls.
 */
function stackFrames(error: unknown): string {
  if (!(error instanceof Error) || !error.stack) return "";
  const cut = error.message ? error.stack.indexOf(error.message) : -1;
  const body = cut >= 0 ? error.stack.slice(cut + error.message.length) : error.stack;
  const frames = body
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .map(oneLine)
    .join("\n")
    .slice(0, 2000);
  return frames ? `\n${frames}` : "";
}

export interface FailureContext {
  /** The caller's signal was aborted — a stopped turn, not a fault. Wins over `escalate`. */
  cancelled?: boolean;
  /** This failure is not routine whatever its code: a human approved it and it did not happen. */
  escalate?: boolean;
}

/**
 * "The human said yes, and it still did not happen" — carried on the error
 * itself, because that fact is known where the throw happens and needed where
 * it is logged.
 *
 * `escalate` used to be derived from a parameter (`approvedSignal`) that only
 * the redemption path passed. With the confirmation inlined into the blocking
 * call, the redemption path is no longer a separate call — but the *window*
 * still is: under `ask`, everything {@link ComputerUseHost.requestAgentAction}
 * throws after `outcome.approved` is a confirmed-but-unfulfilled action, and
 * everything it throws before is an ordinary refusal. A denial, a timeout, an
 * occupied prompt slot and a malformed action are all pre-approval, and none of
 * them escalate.
 *
 * Under `allow` nothing is marked: no human is waiting on the result, so a
 * failure there is an ordinary failure and classifies by its own code.
 *
 * A symbol so it cannot collide with a driver's own field and never reaches
 * the model: `failure()` serializes only `code` and `message`.
 */
const CONFIRMED_BY_HUMAN = Symbol("callboard.computerUse.confirmedByHuman");

export function markConfirmedFailure<E>(error: E): E {
  if (error && typeof error === "object") Object.defineProperty(error, CONFIRMED_BY_HUMAN, { value: true, enumerable: false });
  return error;
}

/** Did this failure happen after a human confirmed the action? See {@link markConfirmedFailure}. */
export function isConfirmedFailure(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as Record<symbol, unknown>)[CONFIRMED_BY_HUMAN] === true;
}

/**
 * Record a computer-control failure for the operator.
 *
 * The HTTP and MCP surfaces both answer the caller with a sanitized message on
 * purpose; this is the other half of that trade — the detail has to land
 * somewhere, and that somewhere is the server log. Error text and identifiers
 * only: browser sessions handle credentials and page content, and none of that
 * belongs here.
 *
 * The level follows *fault*, not HTTP status:
 *
 * - **debug** — the routine codes above, plus anything cancelled. Below the
 *   default `info`, so a healthy host stays silent.
 * - **warn** — `denied`. Nothing is broken, so it is not an error, but it is
 *   the one refusal an operator must be able to see without raising the level:
 *   the service emits no audit event for a denial, repeated ones are a
 *   prompt-injection signal, and `loadComputerUsePolicy` also answers `denied`
 *   for a chat file whose metadata will not parse — a corrupt chat silently
 *   losing computer control.
 * - **error** — `driver_error`, `unsupported`, `timeout`, `disposed` and any
 *   uncoded throwable (reported to clients as `unavailable`). The driver or the
 *   host itself failed; this is what is missing when a session lands in
 *   `failed`. Logged with the message and the stack frames.
 */
export function logComputerUseFailure(operation: string, ids: { chatId?: unknown; sessionId?: unknown }, error: unknown, context: FailureContext = {}): void {
  const label = context.cancelled || isAbort(error) ? "cancelled" : controlCode(error) || "unavailable";
  const where = `${operation} ${controlIds(ids)} code=${label}`;
  const detail = oneLine(error instanceof Error ? error.message : String(error ?? "")).slice(0, 500);
  if (label === "cancelled" || (!context.escalate && ROUTINE_CONTROL_CODES.has(label))) {
    log.debug(`Computer control ${where} refused: ${detail}`);
    return;
  }
  if (label === "denied" && !context.escalate) {
    log.warn(`Computer control ${where} refused: ${detail}`);
    return;
  }
  log.error(`Computer control ${where} failed: ${detail}${stackFrames(error)}`);
}

/**
 * Record that an unattended GUI action is about to run — `computerControl:
 * "allow"`, nobody asked.
 *
 * Under `ask` the record already exists and is better than a log line: the
 * confirmation is a `permission_request` in the chat, so the transcript carries
 * the action, its target and the human's answer. `allow` removes the prompt —
 * and with it that record. Without this line the server retains nothing about
 * what an unattended agent did to a real browser; the operator's only source
 * would be the model's own transcript, which is the one artifact a
 * prompt-injected page can influence.
 *
 * Two properties this line is careful about, both learned the hard way:
 *
 * - **It is an attempt, not a receipt.** It is written *before* the driver is
 *   reached, because a process that dies mid-action must still leave the trace.
 *   So it says "attempting", and {@link logUnattendedFailure} follows when the
 *   action does not complete. No second line means it did — unless the log ends
 *   there, which is the case this ordering exists to keep visible.
 * - **It carries no payload.** {@link describeAgentActionForLog}, not
 *   {@link describeAgentAction}: `controlId`/`oneLine`/`slice` are
 *   log-*injection* guards and redact nothing, and a typed password or a
 *   magic-link query string would otherwise sit in `~/.callboard/logs/` in
 *   plaintext, at the default level, indefinitely. #427's rule — "error text
 *   and identifiers only; browser sessions handle credentials and page content,
 *   and none of that belongs here" — governs this line too.
 *
 * It cannot flood: one line per action the agent was going to take anyway.
 */
export function logUnattendedAction(chatId: string, sessionId: string, redactedSummary: string): void {
  log.info(`Computer control ${controlIds({ chatId, sessionId })} attempting unattended (computerControl=allow): ${oneLine(redactedSummary).slice(0, 500)}`);
}

/**
 * The correction to a {@link logUnattendedAction} line: the action was
 * attempted and did not complete.
 *
 * Needed because an `allow` failure is deliberately not escalated — nobody is
 * waiting on it — so its detailed line lands at `debug` for the routine codes
 * and is invisible at the default level. Without this, the log would say an
 * unattended agent did something it did not do, and contain nothing that says
 * otherwise. Same level as the attempt so the pair greps together; the cause is
 * on the `logComputerUseFailure` line, at `error` when the driver or host
 * actually failed.
 *
 * `context.cancelled` is not optional politeness. On the production path the
 * caller's `execute` is `computer-use-tools`' `call()`, which never throws —
 * it converts everything, a stopped turn included, into an `isError` result
 * carrying `{"error":"unavailable"}`. So the `isAbort` branch below never sees
 * a real abort, and a turn the user stopped would be recorded as an unexplained
 * failure. The caller holds the signal; it says so, exactly as `call()`'s own
 * `logContext()` does. `escalate` has no meaning here — nobody approved this.
 */
export function logUnattendedFailure(chatId: string, sessionId: string, error: unknown, context: FailureContext = {}): void {
  const label = context.cancelled || isAbort(error) ? "cancelled" : controlCode(error) || envelopeCode(error) || "unavailable";
  log.info(`Computer control ${controlIds({ chatId, sessionId })} unattended action did NOT complete (computerControl=allow) code=${label}`);
}

export interface HostPolicy {
  policy: ComputerUsePolicy;
  signature: string;
}
export function loadComputerUsePolicy(chatId: string): HostPolicy {
  const chat = chatFileService.getChat(chatId);
  if (!chat) throw controlError("not_found", "Chat not found");
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(chat.metadata || "{}");
  } catch {
    throw controlError("denied", "Chat permission metadata is unreadable");
  }
  if (!metadata || typeof metadata !== "object" || metadata.archived === true) throw controlError("denied", "Chat is unavailable");
  let routing: Record<string, unknown>;
  try {
    // Use main's current/historical provenance rules; never treat an inherited
    // native-child MCP identity or ambiguous namespace as independently owned.
    routing = parseChatMetadata(resolveSessionContext(chat.session_id, chat.metadata).metadata);
    assertNativeAgentControllable(chatId, { sessionId: chat.session_id, provider: routing.provider });
  } catch {
    throw controlError(
      "denied",
      "Chat ownership or provider provenance is unverified or parent-owned. Use the owning parent thread for native Codex children.",
    );
  }
  const policy = readComputerUsePolicy(metadata.defaultPermissions);
  // The signature is what a grant is bound to; drift revokes the live session.
  // Sign only what changes the authority itself: the permission axes and the
  // engine identity the provenance check just verified. The wider chat
  // fingerprint (session ids, last branch, model, folder) used to be in here,
  // and a nudge resume appending a session id or an acknowledged branch drift
  // revoked the browser mid-turn with "permissions changed".
  return { policy, signature: JSON.stringify([policy, routing.provider, routing.acpProviderId]) };
}
export function controlError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
export const controlPrincipal = (chatId: string, role: "agent" | "human"): Principal => ({ ownerId: chatId, actorId: `${role}:${chatId}`, role });
const uiKind = (kind: string): ComputerTargetKind => (kind === "browser" ? "browser" : "desktop");
const targetId = (kind: ComputerTargetKind) => (kind === "browser" ? "managed-browser" : "native-desktop");
const PROBE_CACHE_MS = 5_000;
interface Grant {
  chatId: string;
  signature: string;
  expiresAt: number;
  lease: Lease;
}
/**
 * A target request visible in the emergency-stop ledger. The Computer panel's
 * legacy Ask request is redeemed by approve(); an in-chat request is reserved
 * here throughout consent/startup and can ONLY be redeemed by its human-only
 * prompt. controlRequests carries cancellation and the late-Stop alias.
 */
interface Pending {
  reason?: string;
  chatId: string;
  kind: ComputerTargetKind;
  signature: string;
  expiresAt: number;
}

/** Action shapes the host will forward. Anything else is rejected unopened. */
const ACTION_TYPES = ["click", "move", "drag", "scroll", "key", "type", "navigate", "wait"];

/**
 * The only approval the panel still shows: a human's own Enable request under
 * "ask". Its per-action promise is scoped to that level, because this record
 * can only exist at that level — under "allow" the Enable click opens the
 * target directly and the agent then acts without a prompt.
 */
const PENDING_TARGET_REASON =
  "Approve access to this specific target for this chat until expiry. Screenshots are sent to the configured model when requested. This chat is set to Ask, so every agent action also needs a separate confirmation — that one is asked in the chat, not here. Subagents the engine runs inside this chat's turn (Claude Code Task subagents, Codex native subagents) share this grant and act under this chat's identity.";

const humanTarget = (kind: ComputerTargetKind) => `${kind === "browser" ? "managed browser" : "native desktop"} on ${hostname()}`;

/**
 * Show the human what they are approving. Never UUIDs, never raw JSON.
 *
 * This one is for a person deciding, so it says everything: the URL with its
 * query string, the text about to be typed. That is the point of a
 * confirmation, and it is the same human/log split #426 drew — see
 * {@link describeAgentActionForLog} for what a log line may keep.
 */
export function describeAgentAction(action: Record<string, unknown>, target: string): string {
  const clip = (value: unknown, limit = 160) => {
    const text = String(value ?? "");
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };
  const at = `(${Number(action.x)}, ${Number(action.y)})`;
  switch (action.type) {
    case "navigate":
      return `Open ${clip(action.url, 300)} in the ${target}`;
    case "click":
      return `${action.button === "right" ? "Right-click" : action.button === "middle" ? "Middle-click" : "Click"} at ${at} in the ${target}`;
    case "move":
      return `Move the pointer to ${at} in the ${target}`;
    case "drag":
      return `Drag from (${Number(action.x)}, ${Number(action.y)}) to (${Number(action.toX)}, ${Number(action.toY)}) in the ${target}`;
    case "scroll":
      return `Scroll by (${Number(action.deltaX)}, ${Number(action.deltaY)}) in the ${target}`;
    case "key":
      return `Press ${clip(action.key, 60)} in the ${target}`;
    case "type":
      return `Type “${clip(action.text)}” into the ${target}`;
    case "wait":
      return `Wait ${Number(action.durationMs)}ms on the ${target}`;
    default:
      return `Perform a ${clip(action.type, 40)} action in the ${target}`;
  }
}

/**
 * The same action, described for the **server log** rather than for a person.
 *
 * A log line is a different artifact from a confirmation prompt: it is written
 * to `~/.callboard/logs/callboard.log` at the default level, kept
 * indefinitely, and pasted into bug reports. So this describes an action's
 * *shape* where the human-facing version describes its content.
 *
 * **It validates first, and that is the load-bearing part.** Everything below
 * is a branch tuned for a well-formed action, and this line is written *before*
 * the action runs — the strict schema does not execute until the MCP hop,
 * inside `execute`. The host's own pre-checks admit any object under 8KB whose
 * `type` is in {@link ACTION_TYPES}, which is nowhere near enough: `new URL()`
 * happily parses `data:text/plain,SECRET` and `javascript:alert(cookie)`, whose
 * origin is the literal string `"null"` and whose entire payload lands in
 * `pathname`. Asking `actionSchema` — the service's own grammar, exported for
 * exactly this — kills that class rather than the two instances of it we
 * happened to find, and keeps killing it if the grammar grows a field.
 *
 * What survives validation is still redacted, because a *valid* action carries
 * content too:
 *
 * - `type` → the character count, never the characters.
 * - `navigate` → origin and path, with any query string or fragment dropped and
 *   the elision marked. Those are the highest-density place for a session
 *   token, though not the only one: a path segment can be a token too, and the
 *   path is kept because dropping it would leave the log unable to say what the
 *   agent was doing at all.
 * - `key` → the name of anything with a name (`Enter`, `Control+a`, `ArrowUp`),
 *   but not a bare single character. A key press is not normally content, and
 *   `type` exists for text — but a secret entered one `key` at a time is still
 *   a secret spread over N log lines, and the character is the one part of that
 *   line nobody needs.
 *
 * The rest are coordinates and durations, which say what happened without
 * saying what was on the screen; they pass through unchanged so the log stays
 * reconstructable.
 */
export function describeAgentActionForLog(action: Record<string, unknown>, target: string): string {
  // A shape the service will reject must not reach a branch below, where a
  // describer written for the valid shape would print its payload verbatim.
  // Even the label is drawn from the known list rather than echoed: the one
  // caller-supplied string on this path is the one string it will not print.
  if (!actionSchema.safeParse(action).success)
    return `Perform an invalid ${ACTION_TYPES.includes(String(action.type)) ? String(action.type) : "unknown"} action in the ${target}`;
  switch (action.type) {
    case "type": {
      const length = String(action.text ?? "").length;
      return `Type ${length} character${length === 1 ? "" : "s"} into the ${target}`;
    }
    case "key":
      return [...String(action.key ?? "")].length === 1 ? `Press a character key in the ${target}` : describeAgentAction(action, target);
    case "navigate": {
      let url: URL;
      try {
        url = new URL(String(action.url ?? ""));
      } catch {
        return `Open an unparseable URL in the ${target}`;
      }
      // Unreachable while the schema above refines the protocol to http/https,
      // and kept anyway. This branch splits a URL into a part it keeps and a
      // part it drops, and an opaque-origin scheme (`data:`, `javascript:`,
      // `blob:`, `file:`) parses fine while putting the whole payload into the
      // part it keeps — so a grammar that widened one day would silently make
      // this the leak. Cheaper to hold the property here than to remember.
      if (!["http:", "https:"].includes(url.protocol) || url.origin === "null") return `Open a non-web URL in the ${target}`;
      const path = url.pathname === "/" ? "" : url.pathname;
      const elided = url.search || url.hash ? " (query omitted)" : "";
      return `Open ${`${url.origin}${path}`.slice(0, 300)}${elided} in the ${target}`;
    }
    default:
      return describeAgentAction(action, target);
  }
}

/** What the human is asked, stripped of transport identifiers. */
export interface ActionConfirmationRequest {
  chatId: string;
  /** One readable line: what will happen, where. */
  summary: string;
  /** The target, in words. */
  target: string;
  /** The immutable snapshot that executes verbatim if approved. */
  action: Record<string, unknown>;
  /** Transport/turn cancellation; an abort is a refusal, never an approval. */
  signal?: AbortSignal;
}
export type ConfirmAgentAction = (request: ActionConfirmationRequest) => Promise<HumanApprovalOutcome>;

/**
 * The tool name the confirmation prompt is attributed to — the same string the
 * model called and the transcript shows. Defined in `shared/` because the chat
 * panel keys its computer-control presentation on this exact value; see the
 * doc comment there for why that match must stay exact.
 */
export { CU_ACTION_TOOL_NAME };

/**
 * The production confirmation: the chat's own blocking prompt.
 *
 * Note what is NOT threaded in here — the chat's `computerControl` level, or
 * any policy at all. The level decides *whether this function is called*, once,
 * in {@link ComputerUseHost.requestAgentAction}; it can never decide what the
 * function answers. `requestHumanApproval` has no auto-decide branch, so once a
 * chat set to "ask" reaches here, nothing short of the authenticated human's
 * POST returns `approved: true`.
 */
export const confirmAgentActionInChat: ConfirmAgentAction = (request) =>
  requestHumanApproval(request.chatId, {
    toolName: CU_ACTION_TOOL_NAME,
    input: { summary: request.summary, target: request.target, action: request.action },
    signal: request.signal,
  });

/** Why the action did not run, in terms the model can act on — and never as an invitation to retry a denial. */
const REFUSALS: Record<HumanApprovalOutcome["reason"], { code: string; message: string }> = {
  human: { code: "denied", message: "Internal error: an approval was treated as a refusal." },
  denied: {
    code: "denied",
    message: "The human refused this GUI action, so it was NOT performed. Do not repeat it or try a variation of it; ask them what to do instead.",
  },
  timeout: {
    code: "approval_timeout",
    // Explicitly not a refusal — that distinction decides whether re-requesting
    // is reasonable, and the tool description tells the model a refusal is final.
    message: "Nobody answered in time, so this GUI action was NOT performed. That is not a refusal: observe the current state, then you may request it again.",
  },
  aborted: {
    code: "cancelled",
    message: "The turn ended before the human confirmed, so this GUI action was NOT performed.",
  },
  no_session: {
    code: "approval_unavailable",
    message:
      "There is no live chat session to confirm a GUI action in, so it was NOT performed. This chat's computer control is set to Ask, so a human has to confirm each action here.",
  },
  prompt_busy: {
    code: "approval_unavailable",
    message:
      "This chat is already waiting on another prompt, so the GUI action was NOT performed. Let the human answer that first, then observe and re-request.",
  },
};

export class ComputerUseHost {
  private readonly grants = new Map<string, Grant>();
  private readonly opening = new Map<string, HostPolicy>();
  private readonly controlRequests = new Map<string, { chatId: string; abort: AbortController; sessionId?: string; expiresAt: number }>();
  private readonly pending = new Map<string, Pending>();
  private readonly events = new Map<string, unknown[]>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly probes = new Map<ComputerTargetKind, { at: number; result: Promise<Awaited<ReturnType<Driver["probe"]>>> }>();
  private readonly watchdog: ReturnType<typeof setInterval>;
  /** Chats with a GUI action currently parked on a human. At most one each. */
  private readonly awaiting = new Set<string>();
  constructor(
    readonly service: ComputerUseService,
    readonly drivers: Readonly<Record<ComputerTargetKind, Driver>>,
    private readonly readPolicy: (chatId: string) => HostPolicy = loadComputerUsePolicy,
    private readonly confirmAction: ConfirmAgentAction = confirmAgentActionInChat,
  ) {
    this.watchdog = setInterval(() => {
      void this.expire();
    }, 1000);
    this.watchdog.unref();
  }
  /** Called by the package before AND after every action/observation. */
  authorize = (request: AuthorizationRequest): "allow" | "deny" => {
    try {
      const current = this.readPolicy(request.principal.ownerId);
      if (computerUseScopeError(uiKind(request.kind), current.policy)) return "deny";
      if (request.operation === "open") {
        const initial = this.opening.get(`${request.principal.ownerId}:${request.targetId}`);
        return initial?.signature === current.signature ? "allow" : "deny";
      }
      const grant = request.sessionId ? this.grants.get(request.sessionId) : undefined;
      return grant && grant.chatId === request.principal.ownerId && grant.signature === current.signature && grant.expiresAt > Date.now() ? "allow" : "deny";
    } catch {
      return "deny";
    }
  };
  private listen(chatId: string) {
    if (this.unsubscribers.has(chatId)) return;
    this.unsubscribers.set(
      chatId,
      this.service.subscribe(controlPrincipal(chatId, "human"), (event) => {
        const entries = this.events.get(chatId) ?? [];
        entries.push(event);
        this.events.set(chatId, entries.slice(-100));
      }),
    );
  }
  private async expire() {
    for (const [id, grant] of this.grants) {
      let valid = grant.expiresAt > Date.now();
      try {
        valid = valid && this.readPolicy(grant.chatId).signature === grant.signature;
      } catch {
        valid = false;
      }
      if (!valid) {
        this.grants.delete(id);
        await this.service.revoke(controlPrincipal(grant.chatId, "human"), id).catch(() => {});
      }
    }
    for (const [id, pending] of this.pending) if (pending.expiresAt <= Date.now()) this.pending.delete(id);
    for (const [id, request] of this.controlRequests)
      if (request.expiresAt <= Date.now()) {
        request.abort.abort();
        this.controlRequests.delete(id);
      }
  }
  /**
   * Driver probes are host facts, not chat facts, and the native one execs
   * `xdotool getdisplaygeometry` with a 5s timeout — on a configured but
   * unreachable DISPLAY every status poll and `cu_open` blocked on it. Cache
   * for a few seconds. Only an *available* result is kept: both shipped
   * drivers catch their own failures and resolve `{ available: false }`, so
   * evicting on rejection alone cached a missing prerequisite for the full
   * window. An unavailable probe is re-run on the next poll so a fix is seen
   * promptly.
   */
  private probe(kind: ComputerTargetKind) {
    const cached = this.probes.get(kind);
    if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.result;
    const result = this.drivers[kind].probe();
    const entry = { at: Date.now(), result };
    this.probes.set(kind, entry);
    result.then(
      (probe) => {
        if (!probe.available && this.probes.get(kind) === entry) this.probes.delete(kind);
      },
      () => {
        if (this.probes.get(kind) === entry) this.probes.delete(kind);
      },
    );
    return result;
  }
  private presentation(value: SessionStatus) {
    return {
      ...value,
      id: value.sessionId,
      kind: value.kind === "browser" ? "browser" : "native",
      controller: value.controller === "none" ? null : value.controller,
      targetLabel: hostname(),
      target: hostname(),
    };
  }
  async status(chatId: string) {
    const { policy } = this.readPolicy(chatId);
    await this.expire();
    const capabilities = await Promise.all(
      (["browser", "desktop"] as const).map(async (kind) => {
        const restriction = computerUseScopeError(kind, policy);
        try {
          // This status is served only to a signed-in human (routes/computer-use.ts
          // is requireSessionAuth-gated; the agent bridge returns sessions alone), so
          // it is the one surface allowed to show the driver's operator diagnostics.
          const { operatorDetail, ...probe } = await this.probe(kind);
          const detailed = [probe.reason, operatorDetail].filter(Boolean).join(" ") || undefined;
          return {
            ...probe,
            kind: kind === "browser" ? "browser" : "native",
            available: probe.available && !restriction,
            reason: restriction ?? detailed,
            ...(kind === "desktop" && restriction ? { readiness: "permission-blocked" as const } : {}),
          };
        } catch {
          return {
            kind: kind === "browser" ? "browser" : "native",
            available: false,
            capabilities: [],
            reason: restriction ?? "Driver probe unavailable. Retry status or ask your agent to check readiness on the Callboard service host.",
            ...(kind === "desktop" ? { readiness: restriction ? ("permission-blocked" as const) : ("unknown" as const) } : {}),
          };
        }
      }),
    );
    const sessions = this.service.status(controlPrincipal(chatId, "human")).map((session) => this.presentation(session));
    for (const [id, pending] of this.pending)
      if (pending.chatId === chatId) {
        // Bound to a variable, not pushed as a fresh literal: `reason` is a
        // viewer-only field the package's SessionStatus does not declare.
        const request = {
          id,
          sessionId: id,
          kind: pending.kind === "browser" ? ("browser" as const) : ("native" as const),
          targetLabel: hostname(),
          target: hostname(),
          targetId: targetId(pending.kind),
          reason: pending.reason ?? PENDING_TARGET_REASON,
          state: "pending_approval" as SessionStatus["state"],
          generation: 0,
          controller: null,
          expiresAt: pending.expiresAt,
        };
        sessions.push(request);
      }
    return {
      capabilities,
      sessions,
      permission: policy.computerControl,
      target: hostname(),
      platform: process.platform,
      events: this.events.get(chatId) ?? [],
      modelVision:
        "Runtime image delivery requires a tool/vision-capable configured model; live artistic/model qualification has not been established on this host.",
    };
  }
  /** Host-only initial consent. Never exported as an MCP open/approve capability. */
  async requestControl(chatId: string, kind: ComputerTargetKind, reason: string, signal: AbortSignal) {
    if (!["browser", "desktop"].includes(kind) || typeof reason !== "string" || !reason.trim() || reason.length > 500)
      throw controlError("invalid_request", "Provide a target kind and a reason of 1–500 characters.");
    signal.throwIfAborted();
    const current = this.readPolicy(chatId);
    const restriction = computerUseScopeError(kind, current.policy);
    if (restriction) throw controlError("denied", `${restriction} The human can change scope explicitly in this chat's permissions dialog.`);
    const existing = this.service
      .status(controlPrincipal(chatId, "agent"))
      .find((s) => s.targetId === targetId(kind) && ["ready", "starting"].includes(s.state));
    if (existing) {
      this.agentLease(chatId, existing.sessionId, existing.generation);
      if (existing.state !== "ready") throw controlError("lease_conflict", "Target is already starting; check cu_open later.");
      return this.presentation(existing);
    }
    if ([...this.pending.values()].some((p) => p.chatId === chatId)) throw controlError("queue_full", "Resolve the existing target request first.");
    const id = randomUUID();
    const abort = new AbortController();
    const combined = AbortSignal.any([signal, abort.signal]);
    const target = hostname();
    const expiresAt = Date.now() + 300_000;
    const record = { chatId, abort, expiresAt } as { chatId: string; abort: AbortController; sessionId?: string; expiresAt: number };
    // Reserve before the first asynchronous probe. Stop can discover this even
    // before the card arrives, and it stays discoverable throughout startup.
    this.controlRequests.set(id, record);
    this.pending.set(id, {
      chatId,
      kind,
      signature: current.signature,
      expiresAt,
      reason: "Enablement is awaiting consent or starting in the chat. Answer the in-chat card; Stop cancels this request.",
    });
    let promptId: string | undefined;
    let complete!: (result: ApprovalCompletion) => void;
    const completion = new Promise<ApprovalCompletion>((resolve) => {
      complete = resolve;
    });
    try {
      const probe = await this.drivers[kind].probe();
      combined.throwIfAborted();
      if (!probe.available) throw controlError("unsupported", probe.reason ?? "Target unavailable. Check native setup on the service host, then retry.");
      if (this.readPolicy(chatId).signature !== current.signature) throw controlError("denied", "Permissions changed; request fresh consent.");
      const previousPrompt = getPendingRequest(chatId)?.requestId;
      const approval = requestHumanApproval(chatId, {
        toolName: CU_REQUEST_CONTROL_TOOL_NAME,
        controlRequest: true,
        completion,
        input: { kind, target, reason: reason.trim(), permission: current.policy.computerControl, durationMinutes: 15, expiresAt },
        signal: combined,
        timeoutMs: Math.max(1, expiresAt - Date.now()),
      });
      const createdPrompt = getPendingRequest(chatId)?.requestId;
      promptId = createdPrompt !== previousPrompt ? createdPrompt : undefined;
      const outcome = await approval;
      if (!outcome.approved)
        throw controlError(
          REFUSALS[outcome.reason].code,
          `Control was not enabled (${outcome.reason}). ${outcome.reason === "denied" ? "Do not repeat a refused request." : "Check current state before requesting again."}`,
        );
      combined.throwIfAborted();
      if (expiresAt <= Date.now() || hostname() !== target || this.readPolicy(chatId).signature !== current.signature)
        throw controlError("denied", "Control consent expired or permissions changed. Request fresh consent.");
      const ready = await this.drivers[kind].probe();
      combined.throwIfAborted();
      if (!ready.available) throw controlError("unsupported", ready.reason ?? "Target is no longer available. Fix host setup before retrying.");
      const session = await this.openApproved(chatId, kind, current, combined);
      // openApproved has its own await boundary. Stop/transport cancellation
      // can land after it registers a grant but before this continuation gets
      // to publish the alias. Fence that session before reporting failure.
      try {
        combined.throwIfAborted();
        if (this.readPolicy(chatId).signature !== current.signature) throw controlError("denied", "Control authority changed during startup.");
      } catch (error) {
        await this.stop(chatId, session.id);
        throw error;
      }
      record.sessionId = session.id;
      record.expiresAt = session.expiresAt;
      complete({ ok: true });
      // Keep the request → session alias through expiry: a Stop dispatched from
      // a tab's pending ledger must also stop a just-completed open.
      sessionRegistry.get(chatId)?.emitter?.emit("event", {
        type: "tool_result",
        content: "",
        controlRequestResult: { requestId: promptId, message: `${kind === "browser" ? "Browser" : "Desktop"} control enabled.` },
        toolName: CU_REQUEST_CONTROL_TOOL_NAME,
      });
      return session;
    } catch (error) {
      complete({
        ok: false,
        error: `${error instanceof Error ? error.message : "Control could not be enabled"} This request is finished; refresh pending state. Any retry needs fresh consent.`,
      });
      this.controlRequests.delete(id);
      sessionRegistry.get(chatId)?.emitter?.emit("event", {
        type: "tool_result",
        content: "",
        controlRequestResult: {
          requestId: promptId,
          message: error instanceof Error ? error.message : "Control could not be enabled. Check status and retry.",
        },
        toolName: CU_REQUEST_CONTROL_TOOL_NAME,
      });
      throw error;
    } finally {
      this.pending.delete(id);
    }
  }
  async open(chatId: string, kind: ComputerTargetKind) {
    const current = this.readPolicy(chatId);
    const restriction = computerUseScopeError(kind, current.policy);
    if (restriction) throw controlError("denied", restriction);
    if (current.policy.computerControl === "ask") {
      if ([...this.pending.values()].filter((p) => p.chatId === chatId).length >= 2)
        throw controlError("queue_full", "Resolve the existing target approval first");
      const id = randomUUID();
      this.pending.set(id, { chatId, kind, signature: current.signature, expiresAt: Date.now() + 120_000 });
      return {
        id,
        sessionId: id,
        kind: kind === "browser" ? "browser" : "native",
        state: "pending_approval",
        controller: null,
        generation: 0,
        targetLabel: hostname(),
      };
    }
    return this.openApproved(chatId, kind, current);
  }
  /** Confirm a human's own Enable request. GUI actions are confirmed in the chat, not here. */
  async approve(chatId: string, id: string, _generation?: unknown) {
    if (this.controlRequests.has(id)) throw controlError("denied", "Answer this request in the chat using its request identity.");
    const pending = this.pending.get(id);
    if (pending && pending.chatId !== chatId) throw controlError("not_found", "Approval not found");
    this.pending.delete(id);
    const current = this.readPolicy(chatId);
    if (
      !pending ||
      pending.chatId !== chatId ||
      pending.expiresAt <= Date.now() ||
      pending.signature !== current.signature ||
      current.policy.computerControl === "deny"
    )
      throw controlError("denied", "Approval expired or its scope changed; enable the target again");
    return this.openApproved(chatId, pending.kind, current);
  }
  private async openApproved(chatId: string, kind: ComputerTargetKind, current: HostPolicy, signal?: AbortSignal) {
    const key = `${chatId}:${targetId(kind)}`;
    if (this.opening.has(key)) throw controlError("lease_conflict", "Target is already starting");
    if (this.service.status(controlPrincipal(chatId, "human")).some((s) => s.targetId === targetId(kind) && ["starting", "ready"].includes(s.state)))
      throw controlError("lease_conflict", "Stop this chat's existing target session first");
    this.listen(chatId);
    this.opening.set(key, current);
    try {
      const lease = await this.service.open(controlPrincipal(chatId, "agent"), targetId(kind), signal);
      try {
        if (signal?.aborted || this.readPolicy(chatId).signature !== current.signature)
          throw controlError("cancelled", "Control startup was cancelled or its authority changed.");
      } catch (error) {
        await this.service.stop(controlPrincipal(chatId, "human"), lease.sessionId);
        throw error;
      }
      this.grants.set(lease.sessionId, { chatId, signature: current.signature, expiresAt: lease.expiresAt, lease });
      return this.presentation(lease);
    } finally {
      this.opening.delete(key);
    }
  }
  private grant(chatId: string, id: string): Grant {
    const grant = this.grants.get(id);
    if (!grant || grant.chatId !== chatId) throw controlError("not_found", "Control session not found");
    if (grant.expiresAt <= Date.now() || this.readPolicy(chatId).signature !== grant.signature) {
      this.grants.delete(id);
      void this.service.revoke(controlPrincipal(chatId, "human"), id);
      throw controlError("revoked", "Control grant expired or permissions changed");
    }
    return grant;
  }
  async observe(chatId: string, id: string) {
    const grant = this.grant(chatId, id);
    return this.service.observe(controlPrincipal(chatId, "human"), { sessionId: id, generation: grant.lease.generation });
  }
  async action(chatId: string, id: string, action: unknown, generation: unknown, frameId: string) {
    const grant = this.grant(chatId, id);
    if (generation !== grant.lease.generation) throw controlError("stale_generation", "Refresh the viewer before acting");
    if (action && typeof action === "object" && (action as { type?: string }).type === "drag") {
      const value = action as { fromX?: unknown; fromY?: unknown; toX?: unknown; toY?: unknown };
      action = { type: "drag", x: value.fromX, y: value.fromY, toX: value.toX, toY: value.toY };
    }
    return this.presentation(
      await this.service.act(controlPrincipal(chatId, "human"), {
        sessionId: id,
        generation: grant.lease.generation,
        leaseId: grant.lease.leaseId,
        actionId: randomUUID(),
        frameId,
        action: action as Action,
      }),
    );
  }
  async takeover(chatId: string, id: string, expectedGeneration?: unknown) {
    const grant = this.grant(chatId, id);
    if (expectedGeneration !== grant.lease.generation) throw controlError("stale_generation", "Refresh control state before takeover");
    grant.lease = await this.service.takeover(controlPrincipal(chatId, "human"), { sessionId: id, generation: grant.lease.generation });
    await this.observe(chatId, id);
    return this.presentation(grant.lease);
  }
  async resume(chatId: string, id: string, expectedGeneration?: unknown) {
    const grant = this.grant(chatId, id);
    if (expectedGeneration !== grant.lease.generation) throw controlError("stale_generation", "Refresh control state before resuming");
    // The service returns the fresh agent observation with the lease. Drop it:
    // a grant must not retain a screenshot, and this endpoint returns control
    // state, not pixels — the viewer observes explicitly.
    const { observation: _observation, ...lease } = await this.service.resume(controlPrincipal(chatId, "human"), {
      sessionId: id,
      generation: grant.lease.generation,
      leaseId: grant.lease.leaseId,
    });
    grant.lease = lease;
    return this.presentation(grant.lease);
  }
  async stop(chatId: string, id: string, _generation?: unknown) {
    const request = this.controlRequests.get(id);
    if (request) {
      if (request.chatId !== chatId) throw controlError("not_found", "Control request not found");
      request.abort.abort();
      if (request.sessionId) {
        await this.stop(chatId, request.sessionId);
        return { id, state: "stopped" };
      }
    }
    if (this.pending.get(id)?.chatId === chatId) {
      this.pending.delete(id);
      return { id, state: "stopped" };
    }
    // Even denied/revoked owners may stop; ownership still enforced by the service.
    const result = await this.service.stop(controlPrincipal(chatId, "human"), id);
    this.grants.delete(id);
    return this.presentation(result);
  }
  async revoke(chatId: string, id: string, _generation?: unknown) {
    if (this.controlRequests.has(id)) return this.stop(chatId, id);
    if (this.pending.get(id)?.chatId === chatId) {
      this.pending.delete(id);
      return { id, state: "revoked" };
    }
    const result = await this.service.revoke(controlPrincipal(chatId, "human"), id);
    this.grants.delete(id);
    return this.presentation(result);
  }
  /**
   * Perform one GUI action, asking the human first if the chat says to.
   *
   * The chat's `computerControl` level is read here, once, and it decides
   * exactly one thing — whether {@link ConfirmAgentAction} is called at all:
   *
   * - **`ask`** — the agent's tool call blocks on a prompt in the chat and
   *   returns the real outcome. Nothing but the authenticated human's POST can
   *   answer it: no policy value, hook, allow-list entry or API key reaches
   *   `requestHumanApproval`, which has no auto-decide branch. This branch is
   *   what `computer-use.invariant.test.ts` pins, end to end.
   * - **`allow`** — the action runs unprompted, bracketed by the operator's
   *   only record of it: {@link logUnattendedAction} before, and
   *   {@link logUnattendedFailure} after if it did not complete. Both carry the
   *   redacted description, never the human-facing one.
   * - **`deny`** — refused here, as it already is at the transport gate, at
   *   `authorize` and at every scope check.
   *
   * What the level does NOT govern, at any value: **who enables a target.**
   * `open`/`approve` are reached only from the signed-in human's
   * `requireSessionAuth` + same-origin control plane, and the agent's `cu_open`
   * only lists sessions a human already started. `requestControl` always waits for authenticated in-chat target consent, under Ask AND Allow. `allow` says what happens
   * after you enable, never who enables.
   *
   * Under `ask`, everything the deferred `approve()` used to re-check on
   * redemption is re-checked after the wait, because a human takes time and the
   * world moves: the grant, its signature, the lease generation, who holds
   * control, and the frame the action was aimed at. Under `allow` there is no
   * wait, so the checks above are still current when `execute` runs.
   */
  async requestAgentAction<T>(
    chatId: string,
    id: string,
    generation: number,
    frameId: string,
    action: unknown,
    /**
     * Runs the action. It is handed the exact snapshot that was validated (and,
     * under `ask`, shown to the human) — do not reach back to the caller's own
     * copy, or "what is shown is what runs" stops being a property of the
     * wiring and becomes a promise. `confirmedByHuman` tells the caller whether
     * someone is waiting on this result; see {@link FailureContext}.
     */
    execute: (actionId: string, approvedAction: Record<string, unknown>, context: { confirmedByHuman: boolean }) => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    const grant = this.grant(chatId, id);
    this.agentLease(chatId, id, generation);
    this.service.assertFrame(controlPrincipal(chatId, "agent"), { sessionId: id, generation, frameId });
    if (
      !action ||
      typeof action !== "object" ||
      Array.isArray(action) ||
      JSON.stringify(action).length > 8192 ||
      !ACTION_TYPES.includes(String((action as { type?: unknown }).type))
    )
      throw controlError("invalid_request", "Action must be a bounded GUI operation");
    const level = this.readPolicy(chatId).policy.computerControl;
    if (level === "deny") throw controlError("denied", "Browser & Computer Control is denied for this chat; no GUI action can be performed");
    const target = humanTarget(uiKind(grant.lease.kind));
    // Prompt and execution share one immutable snapshot: what the human is
    // shown is what runs, even if the caller mutates its object afterwards.
    const request = structuredClone(action) as Record<string, unknown>;
    const summary = describeAgentAction(request, target);
    if (level === "allow") {
      // The human granted unattended control for this chat. All that is left to
      // do is leave a trace of it — an attempt before, and a correction after if
      // it did not happen, because this log is the only account anyone gets and
      // an over-report is the worst way for it to be wrong.
      logUnattendedAction(chatId, id, describeAgentActionForLog(request, target));
      // A stopped turn is not a fault, and it does not arrive as one: `call()`
      // hands back an `isError` result whatever happened, so the abort has to
      // travel with the signal the caller gave us rather than with the error.
      const outcome = (): FailureContext => ({ cancelled: options?.signal?.aborted });
      let result: T;
      try {
        result = await execute(randomUUID(), request, { confirmedByHuman: false });
      } catch (error) {
        logUnattendedFailure(chatId, id, error, outcome());
        throw error;
      }
      // The MCP layer answers a fault as an `isError` result rather than a
      // throw, so the successful-looking return above is not proof of anything.
      if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true) logUnattendedFailure(chatId, id, result, outcome());
      return result;
    }
    // A queue cannot form when the call blocks: the agent's own turn is parked
    // here until this one is answered. What CAN arrive is a second, concurrent
    // tool call in the same assistant block, and two prompts cannot share one
    // chat's prompt slot — so refuse the second explicitly rather than let it
    // clobber the request the human is reading. (This replaces a cap of four
    // parked requests, which was reachable only because the call returned.)
    if (this.awaiting.has(chatId))
      throw controlError("queue_full", "Another GUI action in this chat is already waiting for the human. Request one action at a time.");
    this.awaiting.add(chatId);
    let outcome: HumanApprovalOutcome;
    try {
      outcome = await this.confirmAction({ chatId, summary, target, action: request, signal: options?.signal });
    } finally {
      this.awaiting.delete(chatId);
    }
    if (!outcome.approved) {
      const refusal = REFUSALS[outcome.reason];
      throw controlError(refusal.code, refusal.message);
    }
    // Past this line the human has said yes, so every failure is one they will
    // never see: their click already returned 200 from `/respond`, and only the
    // model is told what happened next. `markConfirmedFailure` is what puts
    // those in the operator's log at error level — see {@link FailureContext}.
    try {
      const current = this.readPolicy(chatId);
      if (grant.signature !== current.signature || current.policy.computerControl === "deny")
        throw controlError("denied", "The chat's control scope changed while this action was awaiting confirmation; enable the target again");
      // Re-derives the grant: expiry, ownership, signature, generation, controller.
      this.agentLease(chatId, id, generation);
      this.service.assertFrame(controlPrincipal(chatId, "agent"), { sessionId: id, generation, frameId });
      if (options?.signal?.aborted)
        throw controlError("cancelled", "The turn ended after the human confirmed but before the action ran; it was NOT performed.");
      const result = await execute(randomUUID(), request, { confirmedByHuman: true });
      if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true)
        throw controlError("driver_error", "The approved action did not complete. Refresh session state before retrying; approval cannot be reused.");
      return result;
    } catch (error) {
      throw markConfirmedFailure(error);
    }
  }
  agentLease(chatId: string, id: string, generation: number) {
    const grant = this.grant(chatId, id);
    if (generation !== grant.lease.generation) throw controlError("stale_generation", "Observe current session state before acting");
    if (grant.lease.controller !== "agent") throw controlError("lease_conflict", "The human has control");
    return { sessionId: id, generation, leaseId: grant.lease.leaseId };
  }
  async dispose() {
    clearInterval(this.watchdog);
    for (const request of this.controlRequests.values()) request.abort.abort();
    this.controlRequests.clear();
    this.grants.clear();
    this.pending.clear();
    this.awaiting.clear();
    for (const off of this.unsubscribers.values()) off();
    this.unsubscribers.clear();
    await this.service.dispose();
  }
}

let hostPromise: Promise<ComputerUseHost> | undefined;
export function getComputerUseHost(): Promise<ComputerUseHost> {
  return (hostPromise ??= (async () => {
    const pkg = await import("@wolpertingerlabs/computer-use");
    const drivers = {
      browser: pkg.createBrowserDriver({ network: "unrestricted", executablePath: process.env.CALLBOARD_BROWSER_EXECUTABLE }),
      desktop: pkg.createNativeDesktopDriver({
        enabled: true,
        display: process.env.CALLBOARD_NATIVE_DISPLAY ?? process.env.DISPLAY,
        acknowledgeFullDesktopAccess: true,
        permissions: { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" },
      }),
    };
    const service = new pkg.ComputerUseService({
      targets: [
        { id: "managed-browser", enabled: true, driver: drivers.browser },
        { id: "native-desktop", enabled: true, driver: drivers.desktop },
      ],
      authorize: (request) => host?.authorize(request) ?? "deny",
    });
    const host: ComputerUseHost = new ComputerUseHost(service, drivers);
    return host;
  })().catch((error) => {
    hostPromise = undefined;
    throw error;
  }));
}
export async function shutdownComputerUse(): Promise<void> {
  const pending = hostPromise;
  hostPromise = undefined;
  if (pending) await (await pending).dispose();
}
