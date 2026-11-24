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
import {
  CU_ACTION_TOOL_NAME,
  CU_REQUEST_CONTROL_TOOL_NAME,
  GUI_ACTION_TYPES,
  RIDE_ALONG_TARGETS,
  RIDE_ALONG_WITHDRAW_TEXT,
  actionWithdrawnNotice,
  callboardNoticeHeader,
  controlWithdrawnNotice,
  type StreamEvent,
} from "shared/types/index.js";
import { assertNativeAgentControllable } from "./codex-native-agents.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { createLogger } from "../utils/logger.js";
import { resolveSessionContext } from "../utils/session-provenance.js";
import { chatFileService } from "./chat-file-service.js";
import {
  AXIS_LABELS,
  COMPUTER_TARGET_KINDS,
  aggregateControlLevel,
  axisFor,
  computerUseScopeError,
  levelFor,
  readComputerUsePolicy,
  type ComputerTargetKind,
  type ComputerUsePolicy,
  type ControlAxis,
} from "./computer-use-policy.js";
import { sessionRegistry } from "./session-registry.js";
import { enqueueChatNotice } from "./chat-notices.js";
import { openHumanApproval, type ApprovalCompletion, type OpenHumanApproval } from "./pending-requests.js";
import {
  SANDBOX_BASE_SESSION_MINUTES,
  SANDBOX_DESKTOP_BOUNDS,
  type ComputerUseContainerState,
  type ComputerUseSandboxInfo,
  type ComputerUseSandboxProfile,
  type SandboxDesktopMode,
  type SandboxDesktopVariant,
} from "shared/types/index.js";
import { managedSandboxDriver } from "./sandbox-containers.js";
import {
  chatDeliveryOwner,
  currentSandboxMode,
  getSandboxDeliveries,
  getSandboxManager,
  sandboxInfo,
  sandboxProfileForConsent,
  type ConsentProfile,
} from "./sandbox-desktop.js";
import type { DeliveryContext, DeliveryOwner, OutboxSource } from "./sandbox-deliverables.js";

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
  // A readiness probe that did not answer within CONTROL_PROBE_TIMEOUT_MS.
  // (Human approvals themselves no longer time out: they stay open until
  // answered or cancelled, and nothing waits on them.)
  "approval_timeout",
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
  /**
   * This failure is not routine whatever its code: a human approved it and it
   * did not happen for a reason other than the world moving on. See
   * {@link ComputerUseHost.executeApprovedAction}.
   */
  escalate?: boolean;
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
 * Record that an unattended GUI action is about to run — the target's axis
 * (`browserControl`, `computerControl` or `sandboxControl`) is `"allow"`, nobody asked.
 *
 * Under `ask` the record already exists and is better than a log line: the
 * confirmation is a `permission_request` in the chat, the agent's tool result
 * and the outcome notice carry the action and what came of it, and the host
 * writes its own info line when an approved action runs (see
 * {@link ComputerUseHost.executeApprovedAction}). `allow` removes the prompt —
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
export function logUnattendedAction(chatId: string, sessionId: string, redactedSummary: string, axis: ControlAxis = "computerControl"): void {
  log.info(`Computer control ${controlIds({ chatId, sessionId })} attempting unattended (${axis}=allow): ${oneLine(redactedSummary).slice(0, 500)}`);
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
function logUnattendedFailure(chatId: string, sessionId: string, error: unknown, context: FailureContext = {}, axis: ControlAxis = "computerControl"): void {
  const label = context.cancelled || isAbort(error) ? "cancelled" : controlCode(error) || envelopeCode(error) || "unavailable";
  log.info(`Computer control ${controlIds({ chatId, sessionId })} unattended action did NOT complete (${axis}=allow) code=${label}`);
}

/** A `controlRequestResult` event as the host emits it, with the target it is about. See {@link ComputerUseHost.emitControlResult}. */
export type ControlResultEvent = StreamEvent & { controlTarget?: ComputerTargetKind };

export interface HostPolicy {
  policy: ComputerUsePolicy;
  signature: string;
}
/**
 * Is this chat archived? Injected rather than imported: the real check
 * (`isChatArchived`, chat-archived.ts) walks chat lineage, whose module imports
 * `claude.ts`, and nothing computer control loads may close that cycle. Server
 * bootstrap installs it; until then nothing is treated as archived, which is
 * only ever the case in unit tests that inject their own policy reader.
 */
let chatArchivedCheck: (chatId: string) => boolean = () => false;
export function setChatArchivedCheck(check: (chatId: string) => boolean): void {
  chatArchivedCheck = check;
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
  // `metadata.archived` is a legacy spelling nothing writes any more; the
  // archive itself lives on the lineage (card lifecycle, `treeArchived`,
  // `childArchived`) and is read through the injected check. An archived chat
  // has no computer control: its open requests are withdrawn by the watchdog
  // and a request redeemed after archive is refused here.
  if (!metadata || typeof metadata !== "object" || metadata.archived === true) throw controlError("denied", "Chat is unavailable");
  if (chatArchivedCheck(chatId)) throw controlError("denied", "Chat is archived");
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
  // Sign only what changes the authority itself: the permission axes (all of
  // them, every control axis included, so changing Browser Use or Sandbox
  // desktop also revokes a live desktop grant) and the
  // engine identity the provenance check just verified. The wider chat
  // fingerprint (session ids, last branch, model, folder) used to be in here,
  // and a nudge resume appending a session id or an acknowledged branch drift
  // revoked the browser mid-turn with "permissions changed".
  return { policy, signature: JSON.stringify([policy, routing.provider]) };
}
export function controlError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
export const controlPrincipal = (chatId: string, role: "agent" | "human"): Principal => ({ ownerId: chatId, actorId: `${role}:${chatId}`, role });
/**
 * The service's target id for each kind. The package knows two driver kinds
 * only (`browser`, `native-desktop`), and the sandbox's remote driver is a
 * `native-desktop` one, so a session's Callboard kind is read off its target
 * id ({@link kindOfTarget}), never off its driver kind.
 */
export const TARGET_IDS: Readonly<Record<ComputerTargetKind, string>> = {
  browser: "managed-browser",
  desktop: "native-desktop",
  sandbox: "sandbox-desktop",
};
const targetId = (kind: ComputerTargetKind) => TARGET_IDS[kind];
/** Unknown ids read as the desktop: the strictest scope rule, never a looser one. */
const kindOfTarget = (id: string): ComputerTargetKind => (id === TARGET_IDS.browser ? "browser" : id === TARGET_IDS.sandbox ? "sandbox" : "desktop");
/** The viewer DTO's kind (`ComputerUseKind`). */
const viewerKind = (kind: ComputerTargetKind) => (kind === "browser" ? ("browser" as const) : kind === "sandbox" ? ("sandbox" as const) : ("native" as const));
/** How a notice or banner names a target: "browser", "desktop", "sandbox desktop". */
const targetNoun = (kind: ComputerTargetKind) => RIDE_ALONG_TARGETS[kind];
const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const PROBE_CACHE_MS = 5_000;
interface Grant {
  chatId: string;
  signature: string;
  expiresAt: number;
  lease: Lease;
  /** What the target itself was when this opened ({@link ComputerUseHost.targetBinding}); a change revokes it. */
  binding: string;
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
}

/**
 * An agent's in-chat request to enable a target (`cu_request_control`). Open
 * until the human answers it or something cancels it; then, once enabled, kept
 * as a request → session alias until the session expires, so a Stop dispatched
 * against the request id still reaches the session it became.
 */
interface ControlRequest {
  chatId: string;
  kind: ComputerTargetKind;
  /** The policy signature the human is being asked under; re-checked on approval. */
  signature: string;
  /** Fences startup after approval; aborted by Stop. */
  abort: AbortController;
  /** The consent card, while it is unanswered. */
  approval?: OpenHumanApproval;
  sessionId?: string;
  /** Infinity until enabled: an unanswered request does not expire. */
  expiresAt: number;
  /** Set when something withdrew it, so an in-flight startup reports why. */
  withdrawn?: { reason: WithdrawReason; noticeTo: string };
  /** Which target the human is asked about ({@link ComputerUseHost.targetIdentity}); re-checked on approval. */
  identity?: string;
  /** The Sandbox desktop profile the human is asked to start (its recipe digest is in `variant`). */
  profile?: ConsentProfile;
}

/**
 * A GUI action under Ask, waiting for the human (`cu_action`). Everything it
 * was validated against is kept, because all of it is checked again on
 * approval: the action only runs if the frame it was aimed at is still the
 * current one.
 */
interface ActionRequest {
  id: string;
  chatId: string;
  sessionId: string;
  generation: number;
  frameId: string;
  /** The immutable snapshot the human is shown and that runs verbatim if approved. */
  action: Record<string, unknown>;
  signature: string;
  summary: string;
  target: string;
  /** Which target, so its own axis (`browserControl`/`computerControl`/`sandboxControl`) is the one re-read. */
  kind: ComputerTargetKind;
  approval?: OpenHumanApproval;
}

/** What `cu_action` returns under Ask: the request is open, and the agent will be told. */
export interface AgentActionPending {
  status: "approval_pending";
  requestId: string;
  summary: string;
  message: string;
  /**
   * Set when this is NOT a new request: the agent asked for something while
   * one of its GUI actions was already waiting, and nothing was done. A field
   * of the tool result only — not on the wire to the browser.
   */
  alreadyPending?: true;
  /** The session the waiting request is aimed at (with `alreadyPending`). */
  sessionId?: string;
}

/** What `cu_request_control` returns while consent is open. */
export interface ControlRequestPending {
  status: "consent_pending";
  state: "pending_approval";
  requestId: string;
  kind: "browser" | "native" | "sandbox";
  message: string;
}

/** What the agent can see of its own open requests (`cu_open`). No prompt identities. */
export interface AgentOpenRequest {
  requestId: string;
  type: "enable_control" | "gui_action";
  kind?: "browser" | "native" | "sandbox";
  summary?: string;
}

/** Action shapes the host will forward. Anything else is rejected unopened. */
const ACTION_TYPES: readonly string[] = GUI_ACTION_TYPES;

/**
 * The only approval the panel still shows: a human's own Enable request under
 * "ask". Its per-action promise is scoped to that level, because this record
 * can only exist at that level — under "allow" the Enable click opens the
 * target directly and the agent then acts without a prompt.
 */
const PENDING_TARGET_REASON =
  "Approve access to this specific target for this chat. This request stays open until you answer it; once approved, the session lasts up to 15 minutes. Screenshots are sent to the configured model when requested. This target is set to Ask, so every agent action also needs a separate confirmation — that one is asked in the chat, not here. Subagents the engine runs inside this chat's turn (Claude Code Task subagents, Codex native subagents) share this grant and act under this chat's identity.";

/**
 * A desktop driver that runs somewhere else (`createRemoteDriver`, the Sandbox
 * desktop's driver when CALLBOARD_SANDBOX_DESKTOP_URL/TOKEN_FILE are set).
 * Recognised by shape so tests and other drivers need no import: it names its
 * endpoint, and can say which host instance is answering there.
 */
interface RemoteTarget {
  endpoint: string;
  /** A Callboard-managed container (one per session) rather than a fixed host: labelled as such. */
  managed?: boolean;
  identity(signal?: AbortSignal): Promise<{ instanceId: string }>;
  /** The host instance an open session landed on (by the service's session id). */
  openedInstance?(sessionId: string): string | undefined;
}
function remoteTarget(driver: Driver): RemoteTarget | undefined {
  const candidate = driver as Partial<RemoteTarget>;
  return typeof candidate.endpoint === "string" && typeof candidate.identity === "function" ? (candidate as RemoteTarget) : undefined;
}
/**
 * What the sandbox target can say about itself for the Computer view, beyond
 * a probe: its mode and why a managed sandbox cannot start, and where a
 * session's container is. Recognised by shape, like {@link RemoteTarget}.
 */
interface SandboxView {
  /** The mode in force now, cheaply: what a sandbox grant is bound to. */
  sandboxMode?(): string;
  sandboxInfo(): ComputerUseSandboxInfo;
  containerState(sessionId: string): ComputerUseContainerState | undefined;
  /** A profile a session can start from now, for this chat; throws with a code and words for the agent otherwise. */
  profileForConsent?(name: string, chatId: string): Promise<ConsentProfile>;
  /** The profile a live session runs (name, summary, limits). */
  sessionProfile?(sessionId: string): ComputerUseSandboxProfile | undefined;
}
const sandboxView = (driver: Driver): SandboxView | undefined => {
  const candidate = driver as Partial<SandboxView>;
  return typeof candidate.sandboxInfo === "function" && typeof candidate.containerState === "function" ? (candidate as SandboxView) : undefined;
};

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

/**
 * Raise a human-only, non-blocking prompt in the chat. The production value is
 * {@link openHumanApproval}; it is a constructor seam only so a test can watch
 * what is asked. Whatever is injected, nothing but its answer callback can
 * approve, and the host only ever runs what it validated itself.
 */
export type RaiseHumanApproval = typeof openHumanApproval;

/**
 * Deliver a message to the chat's agent. `wake` (the default) starts a turn if
 * the chat is idle, else waits for the current one to end; `wake: false` never
 * starts a turn and rides along with the chat's next one. See chat-notices.ts.
 */
export type NotifyAgent = (chatId: string, text: string, options?: { wake?: boolean }) => void;

/**
 * The tool name the confirmation prompt is attributed to — the same string the
 * model called and the transcript shows. Defined in `shared/` because the chat
 * panel keys its computer-control presentation on this exact value; see the
 * doc comment there for why that match must stay exact.
 */
export { CU_ACTION_TOOL_NAME };

/** The human refused — final. Worded so it is never read as an invitation to retry. */
const ACTION_DENIED = "The human refused this GUI action, so it was NOT performed. Do not repeat it or try a variation of it; ask them what to do instead.";

/**
 * An approved action runs outside any tool call, so it gets the same ceiling
 * the tool hop gave it (`computer-use-tools`' 35s MCP timeout). The service's
 * own per-operation timeout (30s) fires first; this is the backstop.
 */
const APPROVED_ACTION_TIMEOUT_MS = 35_000;

/**
 * Codes that mean "the world moved while the human was deciding": the agent
 * observed again, an action ran, the human took over, the session was stopped
 * or expired, or the chat's permissions changed. With no limit on think-time
 * these are an expected outcome of an approval, not a fault, so they log at
 * their ordinary level. Anything else after a human's yes escalates.
 */
const WORLD_MOVED = new Set(["stale_frame", "stale_generation", "lease_conflict", "revoked", "stopped", "not_found", "denied", "cancelled"]);

/**
 * An error code as a notice may print it: one of the codes this host and the
 * package define, else "unavailable". `controlCode` sanitizes but does not
 * restrict, and a code thrown from a driver is not ours to repeat.
 */
const KNOWN_CODES = new Set([...ROUTINE_CONTROL_CODES, "denied", "driver_error", "unsupported", "timeout", "disposed", "unavailable"]);
const knownCode = (code: string) => (KNOWN_CODES.has(code) ? code : "unavailable");

/** Why an approved action did not run, in terms the model can act on. Host-fixed: never driver or page text. */
function approvedActionFailure(code: string): string {
  switch (code) {
    case "stale_frame":
      return "the frame it was aimed at is no longer current (another capture or action replaced it, or the screen was recaptured)";
    case "stale_generation":
    case "lease_conflict":
      return "control of the session changed while the human was deciding (they took over, or resumed, or it restarted)";
    case "revoked":
    case "stopped":
    case "not_found":
      return "the control session was stopped, revoked or expired";
    case "denied":
      return "this chat's Browser Use, Computer Use or Sandbox desktop permissions changed after it was requested";
    default:
      return `it failed while running (${knownCode(code)})`;
  }
}

/** The same outcome for the human who just confirmed it — their banner, not the agent's notice. */
function humanActionFailure(code: string): string {
  switch (code) {
    case "stale_frame":
      return "the screen changed after the agent asked, so it was skipped";
    case "stale_generation":
    case "lease_conflict":
      return "control of the session changed (a takeover or resume), so it was skipped";
    case "revoked":
    case "stopped":
    case "not_found":
      return "the control session had ended";
    case "denied":
      return "this chat's Browser Use, Computer Use or Sandbox desktop permissions changed";
    default:
      return `it failed while running (${knownCode(code)})`;
  }
}

/** What the agent may do next. Only a moved screen is its own to retry; a scope change or an ended session is the human's call. */
function afterApprovedFailure(code: string): string {
  switch (code) {
    case "denied":
      return "Do not request it again; this chat's permissions changed, so ask the human what they want.";
    case "revoked":
    case "stopped":
    case "not_found":
      return "Do not re-request on that session. Check cu_open; a new session needs fresh consent through cu_request_control, so ask the human first.";
    default:
      return "Call cu_observe for a fresh frame, check the action still makes sense, and request it again if so — the approval cannot be reused.";
  }
}

/** Why enabling failed after the human said yes, by code. Host-fixed: a driver's or probe's own text never reaches the agent. */
function enableFailure(code: string): string {
  switch (code) {
    case "denied":
      return "this chat's Browser Use, Computer Use or Sandbox desktop permissions changed before it could start";
    case "unsupported":
      return "the target is not available on the service host";
    case "revoked":
      return "the session was stopped, taken over or expired during startup";
    case "approval_timeout":
      return "the target's readiness check timed out";
    case "lease_conflict":
      return "a session for this target was already starting or running";
    default:
      return `it could not be started (${knownCode(code)})`;
  }
}

/** Every notice opens with the shared prefix, so a ride-along block of them matches `splitRideAlongBlock`'s strict format. */
const noticeHeader = callboardNoticeHeader;

/**
 * How a notice names an action: its request id and its type, nothing else.
 * Notices are read as Callboard's own words, so they never carry the action's
 * content (typed text, a URL, a key name) — all of it agent-supplied, and
 * possibly put there by a page. The type was checked against ACTION_TYPES
 * before the request existed. The agent has the full action in its own
 * history under the same id.
 */
const actionLabel = (record: { id: string; action: Record<string, unknown> }) =>
  `request ${record.id} (a ${ACTION_TYPES.includes(String(record.action.type)) ? String(record.action.type) : "GUI"} action)`;

/**
 * Why an open request was withdrawn before the human answered. Each produces a
 * ride-along notice — it never starts a turn, but the agent's next turn is told
 * — and takes the card down in any live tab. Every reason has two fixed
 * texts: one for the agent's notice, one for the human's banner and for a
 * late answer's refusal. Neither ever carries agent- or page-supplied text.
 */
export const WITHDRAWN = {
  stopped: "stopped",
  panelStop: "panelStop",
  revoked: "revoked",
  scope: "scope",
  sessionEnded: "sessionEnded",
  stale: "stale",
  takeover: "takeover",
  superseded: "superseded",
  agentStop: "agentStop",
} as const;
export type WithdrawReason = (typeof WITHDRAWN)[keyof typeof WITHDRAWN];
/**
 * The agent's words for each reason live in shared/ (`RIDE_ALONG_WITHDRAW_TEXT`),
 * with the advice that follows them: withdrawal notices ride along in a block
 * the transcript splits off only when every line is one of those exact
 * templates. The human's words are here.
 */
const WITHDRAW_HUMAN_TEXT: Readonly<Record<WithdrawReason, string>> = {
  stopped: "you pressed Stop",
  panelStop: "it was stopped from the Computer view",
  revoked: "it was revoked from the Computer view",
  scope: "this chat's Browser Use, Computer Use or Sandbox desktop permissions changed, or the chat was archived or deleted",
  sessionEnded: "its control session ended",
  stale: "the screen changed after the agent asked, so it could no longer run",
  takeover: "you took over control of the session",
  superseded: "the chat was rewound, forked or compressed",
  agentStop: "the agent stopped the session",
};
export const WITHDRAW_TEXT: Readonly<Record<WithdrawReason, { agent: string; human: string }>> = Object.fromEntries(
  (Object.keys(WITHDRAW_HUMAN_TEXT) as WithdrawReason[]).map((reason) => [
    reason,
    { agent: RIDE_ALONG_WITHDRAW_TEXT[reason].agent, human: WITHDRAW_HUMAN_TEXT[reason] },
  ]),
) as Record<WithdrawReason, { agent: string; human: string }>;

/** A readiness check cannot hold an agent or an accepted HTTP response forever. */
export const CONTROL_PROBE_TIMEOUT_MS = 10_000;
function boundedProbe(driver: Driver, signal: AbortSignal, expiresAt: number): ReturnType<Driver["probe"]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: Awaited<ReturnType<Driver["probe"]>>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(controlError("cancelled", "Control readiness check cancelled; no target was enabled."));
    const timer = setTimeout(
      () => finish(controlError("approval_timeout", "Control readiness check timed out. Check host setup before requesting again.")),
      Math.max(0, Math.min(CONTROL_PROBE_TIMEOUT_MS, expiresAt - Date.now())),
    );
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    // The driver may ignore cancellation. Its late resolution/rejection is
    // consumed, but can neither settle this request again nor start a target.
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return driver.probe();
      })
      .then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
  });
}

export class ComputerUseHost {
  private readonly grants = new Map<string, Grant>();
  private readonly opening = new Map<string, HostPolicy & { binding: string }>();
  private readonly controlRequests = new Map<string, ControlRequest>();
  private readonly pending = new Map<string, Pending>();
  private readonly events = new Map<string, unknown[]>();
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly probes = new Map<ComputerTargetKind, { at: number; result: Promise<Awaited<ReturnType<Driver["probe"]>>> }>();
  private readonly watchdog: ReturnType<typeof setInterval>;
  /** chatId → the GUI action waiting on the human. At most one per chat. */
  private readonly actionRequests = new Map<string, ActionRequest>();
  readonly drivers: Readonly<Record<ComputerTargetKind, Driver>>;
  constructor(
    readonly service: ComputerUseService,
    /** `sandbox` may be omitted: it then probes as not configured, exactly as with no endpoint set. */
    drivers: Readonly<Record<"browser" | "desktop", Driver> & Partial<Record<"sandbox", Driver>>>,
    private readonly readPolicy: (chatId: string) => HostPolicy = loadComputerUsePolicy,
    private readonly raiseApproval: RaiseHumanApproval = openHumanApproval,
    private readonly notify: NotifyAgent = (chatId, text, options) => void enqueueChatNotice(chatId, text, options),
  ) {
    this.drivers = { ...drivers, sandbox: drivers.sandbox ?? unconfiguredSandboxDriver() };
    this.watchdog = setInterval(() => {
      void this.expire();
    }, 1000);
    this.watchdog.unref();
  }
  /** The sandbox's driver host, when one is configured. The browser and the local desktop are never remote. */
  private remote(kind: ComputerTargetKind): RemoteTarget | undefined {
    return kind === "sandbox" ? remoteTarget(this.drivers.sandbox) : undefined;
  }
  /** Short label for a target: this machine's name, or the sandbox's endpoint. */
  private targetLabel(kind: ComputerTargetKind): string {
    if (kind !== "sandbox") return hostname();
    const remote = this.remote(kind);
    if (remote?.managed) return "sandbox (container on this machine)";
    return remote ? `sandbox ${remote.endpoint}` : "sandbox (not configured)";
  }
  /** What a person is told the target is, in prompts and action summaries. */
  private humanTarget(kind: ComputerTargetKind): string {
    if (kind === "browser") return `managed browser on ${hostname()}`;
    if (kind === "desktop") return `native desktop on ${hostname()}`;
    const remote = this.remote(kind);
    if (remote?.managed) return `sandbox desktop (a disposable container on ${hostname()})`;
    return remote ? `sandbox desktop at ${remote.endpoint}` : "sandbox desktop";
  }
  /**
   * The identity a consent is bound to: asked under one target, opened on the
   * same one. Locally that is this machine's hostname. For the sandbox it is
   * the endpoint plus the instance id its driver host reports, which a host
   * restart changes — so approving a request after the container was replaced
   * does not open the replacement on the old consent.
   */
  private async targetIdentity(kind: ComputerTargetKind, signal: AbortSignal): Promise<string> {
    if (kind !== "sandbox") return hostname();
    const remote = this.remote(kind);
    if (!remote) throw controlError("unsupported", "The sandbox desktop is not configured on the service host.");
    try {
      const { instanceId } = await remote.identity(AbortSignal.any([signal, AbortSignal.timeout(CONTROL_PROBE_TIMEOUT_MS)]));
      return `${remote.endpoint}#${instanceId}`;
    } catch (error) {
      if (signal.aborted) throw controlError("cancelled", "Control request cancelled; no target was enabled.");
      throw Object.assign(controlError("unsupported", "Could not confirm which sandbox desktop host is answering. Check that it is running, then retry."), {
        cause: error,
      });
    }
  }
  /** The identity, in {@link targetIdentity}'s form, of the host a session actually opened on. Fails closed. */
  private openedIdentity(kind: ComputerTargetKind, sessionId: string): string | undefined {
    if (kind !== "sandbox") return hostname();
    const remote = this.remote(kind);
    if (!remote) return undefined;
    const instanceId = remote.openedInstance?.(sessionId);
    return instanceId ? `${remote.endpoint}#${instanceId}` : undefined;
  }
  /**
   * What a grant on this target is bound to besides the chat's policy: for
   * the sandbox, the mode it runs in (managed, endpoint, off). A session
   * started under one mode is not the target the host now offers under
   * another, so a mode change denies its open (even one still starting), its
   * every later call, and the watchdog revokes it. Empty for the browser and
   * the local desktop.
   */
  private targetBinding(kind: ComputerTargetKind): string {
    if (kind !== "sandbox") return "";
    try {
      const view = sandboxView(this.drivers.sandbox);
      return `mode:${view?.sandboxMode?.() ?? view?.sandboxInfo().mode ?? "fixed"}`;
    } catch {
      return "mode:unknown";
    }
  }
  private bindingHolds(kind: ComputerTargetKind, binding: string): boolean {
    return this.targetBinding(kind) === binding;
  }
  /** Called by the package before AND after every action/observation. */
  authorize = (request: AuthorizationRequest): "allow" | "deny" => {
    try {
      const current = this.readPolicy(request.principal.ownerId);
      // By target id, not driver kind: the sandbox's driver is a native-desktop one.
      const kind = kindOfTarget(request.targetId);
      if (computerUseScopeError(kind, current.policy)) return "deny";
      if (request.operation === "open") {
        const initial = this.opening.get(`${request.principal.ownerId}:${request.targetId}`);
        return initial?.signature === current.signature && this.bindingHolds(kind, initial.binding) ? "allow" : "deny";
      }
      const grant = request.sessionId ? this.grants.get(request.sessionId) : undefined;
      return grant &&
        grant.chatId === request.principal.ownerId &&
        grant.signature === current.signature &&
        grant.expiresAt > Date.now() &&
        this.bindingHolds(kind, grant.binding)
        ? "allow"
        : "deny";
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
      let valid = grant.expiresAt > Date.now() && this.bindingHolds(kindOfTarget(grant.lease.targetId), grant.binding);
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
    // Open requests have no expiry, so this is what retires them when the
    // authority they were asked under goes away: a permission or provenance
    // change, an archived or deleted chat (`readPolicy` throws for both), or —
    // for an action — the session it targets no longer being granted. The
    // approval path checks all of this again; this just takes the card down.
    for (const [id, request] of [...this.controlRequests]) {
      if (request.approval?.isOpen()) {
        if (!this.signatureHolds(request.chatId, request.signature)) this.cancelControlRequest(id, request, WITHDRAWN.scope);
      } else if (request.expiresAt <= Date.now()) {
        request.abort.abort();
        this.controlRequests.delete(id);
      }
    }
    // A panel Enable request (the human's own, under Ask) is not the agent's
    // and gets no notice; it is just cleared once its chat can no longer use it.
    for (const [id, pending] of [...this.pending])
      if (!this.controlRequests.has(id) && !this.signatureHolds(pending.chatId, pending.signature)) this.pending.delete(id);
    for (const record of [...this.actionRequests.values()]) {
      if (!this.signatureHolds(record.chatId, record.signature)) this.cancelActionRequest(record, WITHDRAWN.scope);
      else if (!this.grants.has(record.sessionId)) this.cancelActionRequest(record, WITHDRAWN.sessionEnded);
      // The agent cannot move its own frame while this is pending (observe and
      // act are refused), so a frame that went stale moved under it — a
      // takeover, a resume, the target changing. It can never run now; take
      // the card down rather than leave the human a guaranteed refusal.
      else if (!this.actionCanStillRun(record)) {
        const grant = this.grants.get(record.sessionId);
        // A takeover is the human's own move and has its own advice: the
        // agent cannot act until they choose Resume agent.
        this.cancelActionRequest(record, !grant ? WITHDRAWN.sessionEnded : grant.lease.controller !== "agent" ? WITHDRAWN.takeover : WITHDRAWN.stale);
      }
    }
  }
  private signatureHolds(chatId: string, signature: string): boolean {
    try {
      return this.readPolicy(chatId).signature === signature;
    } catch {
      return false;
    }
  }
  /**
   * Tell any live tab to take a withdrawn or finished card down, with a one-line reason.
   *
   * `controlTarget` is for the stream handler only and never reaches the wire
   * (the handler forwards `controlRequestResult` alone): a sandbox result is
   * not sent to a tab that was never sent the sandbox card (utils/sse.ts).
   */
  private emitControlResult(chatId: string, toolName: string, requestId: string | undefined, message: string, kind: ComputerTargetKind) {
    const event: ControlResultEvent = { type: "tool_result", content: "", controlRequestResult: { requestId, message }, toolName, controlTarget: kind };
    sessionRegistry.get(chatId)?.emitter?.emit("event", event);
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
  /**
   * A session as the viewer DTO. `legacy` is for a client without
   * `sandbox_target`: a sandbox session is shown to it as `"native"` (a kind it
   * accepts) with its own `sandbox <endpoint>` label, so its emergency Stop
   * still finds and stops it. See {@link status}.
   */
  private presentation(value: SessionStatus, legacy = false) {
    const kind = kindOfTarget(value.targetId);
    const view = kind === "sandbox" ? sandboxView(this.drivers.sandbox) : undefined;
    const container = view?.containerState(value.sessionId);
    const profileName = kind === "sandbox" ? sessionProfileName(value.variant) : undefined;
    const profile = profileName ? (view?.sessionProfile?.(value.sessionId) ?? { name: profileName }) : undefined;
    return {
      ...value,
      ...(container ? { container } : {}),
      ...(profile ? { profile } : {}),
      id: value.sessionId,
      kind: legacy && kind === "sandbox" ? ("native" as const) : viewerKind(kind),
      controller: value.controller === "none" ? null : value.controller,
      targetLabel: this.targetLabel(kind),
      target: this.targetLabel(kind),
    };
  }
  /**
   * How the sandbox is run, for a prompt's `input.sandbox`: the consent and
   * per-action cards describe a managed container (fresh per session, its
   * network) and a shared endpoint differently (`sandboxDesktopText`). `input`
   * is an opaque record, so this is no wire change; a card without it reads
   * as the shared container, the stricter description.
   */
  private sandboxPromptVariant(kind: ComputerTargetKind): { sandbox?: SandboxDesktopVariant } {
    if (kind !== "sandbox") return {};
    try {
      const info = sandboxView(this.drivers.sandbox)?.sandboxInfo();
      if (!info) return {};
      return { sandbox: { mode: info.mode, ...(info.mode === "managed" && info.network ? { network: info.network } : {}) } };
    } catch {
      return {};
    }
  }
  /** The sandbox capability's extra field (mode, problem, running/limit), when its driver reports one. */
  private sandboxCapability(kind: ComputerTargetKind): { sandbox?: ComputerUseSandboxInfo } {
    if (kind !== "sandbox") return {};
    try {
      const info = sandboxView(this.drivers.sandbox)?.sandboxInfo();
      return info ? { sandbox: info } : {};
    } catch {
      return {};
    }
  }
  /**
   * End every live session on one target, as Revoke does: for a change the
   * target itself went through (the Sandbox desktop's mode), not a chat's
   * permissions. Each ends through the service, so a managed container is
   * removed on the way.
   */
  async revokeTarget(kind: ComputerTargetKind): Promise<number> {
    let count = 0;
    for (const [id, grant] of [...this.grants]) {
      if (kindOfTarget(grant.lease.targetId) !== kind) continue;
      this.grants.delete(id);
      this.cancelSessionActionRequest(grant.chatId, id, WITHDRAWN.revoked);
      await this.service.revoke(controlPrincipal(grant.chatId, "human"), id).catch(() => {});
      count++;
    }
    // Sessions still starting have no grant yet. Stopping one fences its open
    // (the driver's start is aborted and cleans up), so it never gets one; the
    // mode binding in `authorize` catches any that finishes in between.
    const suffix = `:${targetId(kind)}`;
    for (const key of [...this.opening.keys()]) {
      if (!key.endsWith(suffix)) continue;
      const chatId = key.slice(0, -suffix.length);
      for (const session of this.service.status(controlPrincipal(chatId, "human")))
        if (session.targetId === targetId(kind) && session.state === "starting") {
          await this.service.stop(controlPrincipal(chatId, "human"), session.sessionId).catch(() => {});
          count++;
        }
    }
    return count;
  }
  /**
   * The chat's computer-control status for the Computer view.
   *
   * `options.sandbox` says whether the caller understands the sandbox target
   * (`CLIENT_CAPS.sandboxTarget`, read off the request's handshake headers by
   * routes/computer-use.ts). `"sandbox"` is a `ComputerUseKind` an older
   * bundle has no branch for (its `validateStatus` rejects the whole status),
   * so without it:
   *  - the sandbox capability is left out, and the aggregate `permission`
   *    covers the other two axes only — that tab can neither see nor offer
   *    an Enable for it;
   *  - its pending requests are left out — a pending row is one the panel
   *    offers to approve, and that tab cannot know what it would approve;
   *  - its sessions are NOT left out: they are listed as `"native"`, labelled
   *    `sandbox <endpoint>`. That tab's emergency Stop discovers sessions, and
   *    verifies they stopped, through this status; hiding a live sandbox
   *    session would let it report "stopped" while the agent kept acting.
   *    Their events are listed with them.
   * Default `true` for in-process callers (the agent's `cu_open`), which are
   * not old tabs.
   */
  async status(chatId: string, options: { sandbox?: boolean } = {}) {
    const { policy } = this.readPolicy(chatId);
    await this.expire();
    const legacy = options.sandbox === false;
    const kinds = legacy ? COMPUTER_TARGET_KINDS.filter((kind) => kind !== "sandbox") : COMPUTER_TARGET_KINDS;
    const capabilities = await Promise.all(
      kinds.map(async (kind) => {
        const restriction = computerUseScopeError(kind, policy);
        try {
          // This status is served only to a signed-in human (routes/computer-use.ts
          // is requireSessionAuth-gated; the agent bridge returns sessions alone), so
          // it is the one surface allowed to show the driver's operator diagnostics.
          const { operatorDetail, ...probe } = await this.probe(kind);
          const detailed = [probe.reason, operatorDetail].filter(Boolean).join(" ") || undefined;
          return {
            ...probe,
            kind: viewerKind(kind),
            available: probe.available && !restriction,
            reason: restriction ?? detailed,
            permission: levelFor(kind, policy),
            ...(kind !== "browser" && restriction ? { readiness: "permission-blocked" as const } : {}),
            ...this.sandboxCapability(kind),
          };
        } catch {
          return {
            kind: viewerKind(kind),
            available: false,
            capabilities: [],
            reason: restriction ?? "Driver probe unavailable. Retry status or ask your agent to check readiness on the Callboard service host.",
            permission: levelFor(kind, policy),
            ...(kind !== "browser" ? { readiness: restriction ? ("permission-blocked" as const) : ("unknown" as const) } : {}),
            ...this.sandboxCapability(kind),
          };
        }
      }),
    );
    const sessions = this.service.status(controlPrincipal(chatId, "human")).map((session) => this.presentation(session, legacy));
    for (const [id, pending] of this.pending)
      if (pending.chatId === chatId && kinds.includes(pending.kind)) {
        // Bound to a variable, not pushed as a fresh literal: `reason` is a
        // viewer-only field the package's SessionStatus does not declare.
        const request = {
          id,
          sessionId: id,
          kind: viewerKind(pending.kind),
          targetLabel: this.targetLabel(pending.kind),
          target: this.targetLabel(pending.kind),
          targetId: targetId(pending.kind),
          reason: pending.reason ?? PENDING_TARGET_REASON,
          state: "pending_approval" as SessionStatus["state"],
          generation: 0,
          controller: null,
          // No expiry: the request stays until it is answered or stopped. The
          // field stays numeric for the viewer DTO's shape.
          expiresAt: Number.MAX_SAFE_INTEGER,
        };
        sessions.push(request);
      }
    return {
      capabilities,
      sessions,
      // Aggregate (most permissive) for old panels; per-target levels are on each capability.
      permission: aggregateControlLevel(policy, kinds),
      target: hostname(),
      platform: process.platform,
      // Every session is listed for every client (see above), so are its events.
      events: this.events.get(chatId) ?? [],
      modelVision:
        "Runtime image delivery requires a tool/vision-capable configured model; live artistic/model qualification has not been established on this host.",
    };
  }
  /**
   * Ask the human, in the chat, to enable a target — and return straight away.
   *
   * Host-only initial consent; never exported as an MCP open/approve
   * capability. The tool call does not wait for the answer: it gets
   * `consent_pending` and a request id, the consent card stays in the chat
   * until the human answers (no timer), and the outcome reaches the agent as a
   * chat notice. On approval everything is re-checked — the policy signature,
   * the host, a fresh readiness probe — before the target opens, and the human's
   * `/respond` waits for that startup so a failure is shown to them too.
   *
   * Withdrawn by: the chat's Stop button and a rewind/fork/compress
   * ({@link withdrawChatRequests}), the Computer view's Stop/Revoke on the
   * request id, and a change of the chat's permissions or provenance, or
   * archiving/deleting it (the watchdog). Never by the human just sending a
   * message. Every withdrawal reaches the agent as a ride-along notice.
   *
   * A request already waiting — the agent's own, or a human's Enable still
   * open in the Computer view — is reported back as `consent_pending` rather
   * than refused, so a forgotten one is not a dead end.
   */
  async requestControl(chatId: string, kind: ComputerTargetKind, reason: string, signal: AbortSignal, options: { profile?: string } = {}) {
    if (!COMPUTER_TARGET_KINDS.includes(kind) || typeof reason !== "string" || !reason.trim() || reason.length > 500)
      throw controlError("invalid_request", "Provide a target kind and a reason of 1–500 characters.");
    // "base" (or nothing) is the base sandbox desktop; any other name is a profile, sandbox only.
    const profileName = options.profile === undefined || options.profile === "base" ? undefined : options.profile;
    if (profileName !== undefined && (kind !== "sandbox" || typeof profileName !== "string" || !/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(profileName)))
      throw controlError("invalid_request", kind !== "sandbox" ? "A profile applies only to the sandbox target." : "Invalid profile name.");
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
      const running = kind === "sandbox" ? sessionProfileName(existing.variant) : undefined;
      if (running !== profileName)
        throw controlError(
          "lease_conflict",
          `This chat already has a sandbox session (${running ? `profile ${running}` : "the base desktop"}), not ${profileName ? `profile ${profileName}` : "the base desktop"}. Stop it with cu_stop first if you need the other one; starting it needs fresh consent.`,
        );
      return this.presentation(existing);
    }
    // One target request per chat. Rather than refuse, say what is already
    // waiting — an agent's earlier request, or a human's own Enable request
    // still open in the Computer view — so a forgotten one is not a dead end.
    const waiting = [...this.pending.entries()].find(([, p]) => p.chatId === chatId);
    if (waiting) {
      const [waitingId, waitingRequest] = waiting;
      const agents = this.controlRequests.has(waitingId);
      return {
        status: "consent_pending",
        state: "pending_approval",
        requestId: waitingId,
        kind: viewerKind(waitingRequest.kind),
        message: agents
          ? `Nothing new was requested: your earlier request ${waitingId} to enable ${targetNoun(waitingRequest.kind)} control is still waiting for the human in this chat. You will be told the outcome; do not request again meanwhile.`
          : `Nothing new was requested: the human already has a request to enable ${targetNoun(waitingRequest.kind)} control open in this chat's Computer view, waiting for them to confirm it there. Ask them to confirm or cancel it; once it is enabled it appears in cu_open.`,
      } satisfies ControlRequestPending;
    }
    const id = randomUUID();
    const target = this.targetLabel(kind);
    const record: ControlRequest = { chatId, kind, signature: current.signature, abort: new AbortController(), expiresAt: Infinity };
    if (profileName !== undefined) {
      const view = sandboxView(this.drivers.sandbox);
      if (!view?.profileForConsent) throw controlError("unsupported", "Sandbox profiles are not available on this Callboard.");
      try {
        record.profile = await view.profileForConsent(profileName, chatId);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        throw controlError(
          code === "invalid_request" ? "invalid_request" : "unsupported",
          error instanceof Error ? error.message : "That profile is not available.",
        );
      }
      signal.throwIfAborted();
    }
    // Reserve before the first asynchronous probe. Stop can discover this even
    // before the card arrives, and it stays discoverable until it is answered.
    this.controlRequests.set(id, record);
    this.pending.set(id, {
      chatId,
      kind,
      signature: current.signature,
      reason: "Enablement is awaiting consent in the chat. Answer the in-chat card; Stop cancels this request.",
    });
    try {
      // Bounded (CONTROL_PROBE_TIMEOUT_MS), and run before asking: a human
      // should not be asked to enable a target this host cannot provide.
      const probe = await boundedProbe(this.drivers[kind], AbortSignal.any([signal, record.abort.signal]), Date.now() + CONTROL_PROBE_TIMEOUT_MS);
      record.abort.signal.throwIfAborted();
      signal.throwIfAborted();
      if (!probe.available) throw controlError("unsupported", probe.reason ?? "Target unavailable. Check native setup on the service host, then retry.");
      record.identity = await this.targetIdentity(kind, AbortSignal.any([signal, record.abort.signal]));
      if (this.readPolicy(chatId).signature !== current.signature) throw controlError("denied", "Permissions changed; request fresh consent.");
    } catch (error) {
      this.dropControlRequest(id, record);
      throw error;
    }
    record.approval = this.raiseApproval(
      chatId,
      {
        toolName: CU_REQUEST_CONTROL_TOOL_NAME,
        controlRequest: true,
        input: {
          kind,
          target,
          reason: reason.trim(),
          permission: levelFor(kind, current.policy),
          durationMinutes: record.profile?.limits.sessionMinutes ?? SANDBOX_BASE_SESSION_MINUTES,
          ...this.sandboxPromptVariant(kind),
          // The profile the human is asked to start: its name, summary and the limits it will get.
          ...(record.profile
            ? { profile: { name: record.profile.name, description: record.profile.description, gl: record.profile.gl, limits: record.profile.limits } }
            : {}),
        },
      },
      (approved) => (approved ? this.enableApproved(id, record) : this.refuseControl(id, record)),
    );
    return {
      status: "consent_pending",
      state: "pending_approval",
      requestId: id,
      kind: viewerKind(kind),
      message:
        "Consent pending: the human has been asked in this chat to enable this target. This call does not wait — you will be told the outcome in this chat when they answer, and there is nothing to poll. Do not request again meanwhile; carry on with work that does not need the target, or end your turn.",
    } satisfies ControlRequestPending;
  }
  private dropControlRequest(id: string, record: ControlRequest) {
    if (this.controlRequests.get(id) === record) this.controlRequests.delete(id);
    this.pending.delete(id);
  }
  /**
   * Withdraw an unanswered enable request, or fence one whose startup is in
   * flight (that path reports through {@link enableApproved}'s catch). Either
   * way the agent gets a ride-along notice with the reason — it was promised
   * an outcome — and nothing starts a turn. `noticeTo` is the chat that
   * carries the conversation on (a rewind's new chat), when not this one.
   */
  private cancelControlRequest(id: string, record: ControlRequest, reason: WithdrawReason, noticeTo = record.chatId) {
    record.withdrawn = { reason, noticeTo };
    record.abort.abort();
    const wasOpen = record.approval?.cancel(WITHDRAW_TEXT[reason].human) ?? false;
    if (wasOpen || !record.approval) {
      this.dropControlRequest(id, record);
      this.emitControlResult(
        record.chatId,
        CU_REQUEST_CONTROL_TOOL_NAME,
        record.approval?.requestId,
        `The enable request was withdrawn: ${WITHDRAW_TEXT[reason].human}.`,
        record.kind,
      );
      // A request still in its pre-consent probe belongs to a live tool call,
      // which reports the cancellation itself.
      if (record.approval) this.notifyControlWithdrawn(id, record, reason, noticeTo);
    }
  }
  private notifyControlWithdrawn(id: string, record: ControlRequest, reason: WithdrawReason, noticeTo: string) {
    this.notify(noticeTo, controlWithdrawnNotice(record.kind, id, reason), { wake: false });
  }
  private refuseControl(id: string, record: ControlRequest): void {
    if (this.controlRequests.get(id) !== record) return;
    this.dropControlRequest(id, record);
    const label = targetNoun(record.kind);
    this.emitControlResult(
      record.chatId,
      CU_REQUEST_CONTROL_TOOL_NAME,
      record.approval?.requestId,
      `${capitalized(label)} control was not enabled.`,
      record.kind,
    );
    this.notify(
      record.chatId,
      `${noticeHeader(`${label} control was NOT enabled`)}\n\nThe human refused your request ${id} to enable ${label} control. Do not request it again; ask them what to do instead.`,
    );
  }
  /** The human said yes: re-check, probe, open, and tell both of them. Resolves for `/respond`. */
  private async enableApproved(id: string, record: ControlRequest): Promise<ApprovalCompletion> {
    const { chatId, kind } = record;
    const signal = record.abort.signal;
    const label = capitalized(targetNoun(kind));
    try {
      if (this.controlRequests.get(id) !== record || signal.aborted) throw controlError("cancelled", "This request was withdrawn before it was answered.");
      const current = this.readPolicy(chatId);
      if (current.signature !== record.signature || computerUseScopeError(kind, current.policy))
        throw controlError("denied", "Permissions changed since this was requested. Request fresh consent.");
      if ((await this.targetIdentity(kind, signal)) !== record.identity)
        throw controlError("unsupported", "The target changed since this was requested (a different host is answering there). Request fresh consent.");
      const ready = await boundedProbe(this.drivers[kind], signal, Date.now() + CONTROL_PROBE_TIMEOUT_MS);
      signal.throwIfAborted();
      if (!ready.available) throw controlError("unsupported", ready.reason ?? "Target is no longer available. Fix host setup before retrying.");
      const session = await this.openApproved(
        chatId,
        kind,
        current,
        signal,
        record.profile ? { variant: record.profile.variant, ttlMs: record.profile.limits.sessionMinutes * 60_000 } : undefined,
      );
      // openApproved has its own await boundary. Stop can land after it
      // registers a grant but before this continuation publishes the alias.
      // Fence that session before reporting failure.
      try {
        signal.throwIfAborted();
        if (this.readPolicy(chatId).signature !== record.signature) throw controlError("denied", "Control authority changed during startup.");
        // Bind the consent to the session that actually opened, not just to the
        // host checked before opening: a remote host replaced between that
        // check and open would otherwise get the session. The remote driver
        // records the instance each session opened on (proven by the host's
        // handshake), so compare that, with no further round trip. A
        // replacement *after* open cannot slip through either: the session's
        // attach connection was to the old instance, so it is lost and failed.
        if (this.openedIdentity(kind, session.id) !== record.identity)
          throw controlError("unsupported", "The target changed while it was starting (a different host is answering there). Request fresh consent.");
        this.agentLease(chatId, session.id, session.generation);
        const actual = this.service.status(controlPrincipal(chatId, "agent")).find((s) => s.sessionId === session.id);
        if (!actual || actual.state !== "ready" || actual.controller !== "agent" || actual.generation !== session.generation || actual.expiresAt <= Date.now())
          throw controlError("revoked", "Control was stopped, taken over, or expired during startup. Request fresh consent.");
      } catch (error) {
        await this.stop(chatId, session.id);
        throw error;
      }
      // Keep the request → session alias through expiry: a Stop dispatched
      // from a tab's pending ledger must also stop a just-completed open.
      record.sessionId = session.id;
      record.expiresAt = session.expiresAt;
      this.emitControlResult(chatId, CU_REQUEST_CONTROL_TOOL_NAME, record.approval?.requestId, `${label} control enabled.`, kind);
      this.notify(
        chatId,
        `${noticeHeader(`${label.toLowerCase()} control enabled`)}\n\nThe human approved your request ${id}. Session ${session.id} (generation ${session.generation})${record.profile ? ` on sandbox profile ${record.profile.name}` : ""} is ready and agent-controlled for up to ${Math.max(1, Math.round((session.expiresAt - Date.now()) / 60_000))} minutes. Call cu_observe with it for a fresh frame before acting.`,
      );
      return { ok: true };
    } catch (error) {
      if (this.controlRequests.get(id) === record) this.controlRequests.delete(id);
      const stopped = signal.aborted;
      const message = error instanceof Error ? error.message : "Control could not be enabled. Check status and retry.";
      logComputerUseFailure("cu_request_control", { chatId }, error, { cancelled: stopped });
      this.emitControlResult(chatId, CU_REQUEST_CONTROL_TOOL_NAME, record.approval?.requestId, message, kind);
      // A withdrawal (Stop, a permission change…) is the human's own doing
      // and must not start a turn, but the agent is still told, next turn.
      if (stopped && record.withdrawn) this.notifyControlWithdrawn(id, record, record.withdrawn.reason, record.withdrawn.noticeTo);
      else if (!stopped)
        this.notify(
          chatId,
          `${noticeHeader(`${label.toLowerCase()} control was NOT enabled`)}\n\nThe human approved your request ${id}, but enabling failed: ${enableFailure(controlCode(error))}. Check cu_open; any retry needs fresh consent through cu_request_control.`,
        );
      return { ok: false, error: `${message} This request is finished; refresh pending state. Any retry needs fresh consent.` };
    } finally {
      this.pending.delete(id);
    }
  }
  async open(chatId: string, kind: ComputerTargetKind) {
    const current = this.readPolicy(chatId);
    const restriction = computerUseScopeError(kind, current.policy);
    if (restriction) throw controlError("denied", restriction);
    if (levelFor(kind, current.policy) === "ask") {
      if ([...this.pending.values()].filter((p) => p.chatId === chatId).length >= 2)
        throw controlError("queue_full", "Resolve the existing target approval first");
      const id = randomUUID();
      // No expiry: it waits for the human. approve() re-checks its signature
      // and scope, so a request that outlived a permission change is refused.
      this.pending.set(id, { chatId, kind, signature: current.signature });
      return {
        id,
        sessionId: id,
        kind: viewerKind(kind),
        state: "pending_approval",
        controller: null,
        generation: 0,
        targetLabel: this.targetLabel(kind),
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
    if (!pending || pending.chatId !== chatId || pending.signature !== current.signature || levelFor(pending.kind, current.policy) === "deny")
      throw controlError("denied", "Approval was withdrawn or its scope changed; enable the target again");
    return this.openApproved(chatId, pending.kind, current);
  }
  private async openApproved(
    chatId: string,
    kind: ComputerTargetKind,
    current: HostPolicy,
    signal?: AbortSignal,
    openOptions?: { variant: string; ttlMs: number },
  ) {
    const key = `${chatId}:${targetId(kind)}`;
    if (this.opening.has(key)) throw controlError("lease_conflict", "Target is already starting");
    if (this.service.status(controlPrincipal(chatId, "human")).some((s) => s.targetId === targetId(kind) && ["starting", "ready"].includes(s.state)))
      throw controlError("lease_conflict", "Stop this chat's existing target session first");
    this.listen(chatId);
    const binding = this.targetBinding(kind);
    this.opening.set(key, { ...current, binding });
    try {
      const lease = await this.service.open(controlPrincipal(chatId, "agent"), targetId(kind), signal, openOptions);
      try {
        if (signal?.aborted || this.readPolicy(chatId).signature !== current.signature || !this.bindingHolds(kind, binding))
          throw controlError("cancelled", "Control startup was cancelled or its authority changed.");
      } catch (error) {
        await this.service.stop(controlPrincipal(chatId, "human"), lease.sessionId);
        throw error;
      }
      this.grants.set(lease.sessionId, { chatId, signature: current.signature, expiresAt: lease.expiresAt, lease, binding });
      return this.presentation(lease);
    } finally {
      this.opening.delete(key);
    }
  }
  private grant(chatId: string, id: string): Grant {
    const grant = this.grants.get(id);
    if (!grant || grant.chatId !== chatId) throw controlError("not_found", "Control session not found");
    if (
      grant.expiresAt <= Date.now() ||
      this.readPolicy(chatId).signature !== grant.signature ||
      !this.bindingHolds(kindOfTarget(grant.lease.targetId), grant.binding)
    ) {
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
      if (request.approval?.isOpen()) {
        this.cancelControlRequest(id, request, WITHDRAWN.panelStop);
        return { id, state: "stopped" };
      }
      if (!request.sessionId) request.withdrawn = { reason: WITHDRAWN.panelStop, noticeTo: chatId };
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
    this.cancelSessionActionRequest(chatId, id, WITHDRAWN.panelStop);
    return this.presentation(result);
  }
  async revoke(chatId: string, id: string, _generation?: unknown) {
    const request = this.controlRequests.get(id);
    if (request?.chatId === chatId && request.approval?.isOpen()) {
      this.cancelControlRequest(id, request, WITHDRAWN.revoked);
      return { id, state: "revoked" };
    }
    if (request) return this.stop(chatId, id);
    if (this.pending.get(id)?.chatId === chatId) {
      this.pending.delete(id);
      return { id, state: "revoked" };
    }
    const result = await this.service.revoke(controlPrincipal(chatId, "human"), id);
    this.grants.delete(id);
    this.cancelSessionActionRequest(chatId, id, WITHDRAWN.revoked);
    return this.presentation(result);
  }
  /**
   * Perform one GUI action, or ask the human first if the chat says to.
   *
   * The level of the grant's target axis (`browserControl` for the browser,
   * `computerControl` for the desktop) is read here, once, and it decides
   * exactly one thing — whether the action runs now or is put to the human:
   *
   * - **`ask`** — nothing runs. A confirmation card is raised in the chat and
   *   the call returns at once with {@link AgentActionPending}; the agent is
   *   not suspended on the answer, and the card has no timer. Nothing but the
   *   authenticated human's POST can answer it: no policy value, hook,
   *   allow-list entry, parent chat or API key reaches the answer callback of
   *   {@link openHumanApproval}, which has no auto-decide branch. On approval
   *   {@link executeApprovedAction} runs the stored snapshot only if the frame
   *   it was aimed at is still current, and the outcome — performed, refused,
   *   or not performed because the world moved — reaches the agent as a chat
   *   notice. This branch is what `computer-use.invariant.test.ts` pins, end
   *   to end.
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
   * only lists sessions a human already started. `requestControl` always asks
   * for authenticated in-chat target consent, under Ask AND Allow. `allow` says
   * what happens after you enable, never who enables.
   *
   * One action request is open per chat, and nothing the agent sends while it
   * waits replaces it: `cu_action` answers with the pending request
   * ({@link pendingAgentAction}) and `cu_observe` on its session is refused
   * the same way, so the agent can neither swap the card under the human's
   * cursor nor invalidate the frame they are being asked about. If the frame
   * goes stale under it anyway (a takeover, the target changing), the
   * watchdog withdraws it with a notice. The agent may withdraw its own with
   * `cu_stop`.
   */
  async requestAgentAction<T>(
    chatId: string,
    id: string,
    generation: number,
    frameId: string,
    action: unknown,
    /**
     * Runs the action, under `allow` only. It is handed the exact snapshot that
     * was validated — do not reach back to the caller's own copy, or "what is
     * checked is what runs" stops being a property of the wiring and becomes a
     * promise. Under `ask` the host runs the approved snapshot itself, later,
     * outside the tool call; see {@link executeApprovedAction}.
     */
    execute: (actionId: string, approvedAction: Record<string, unknown>) => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T | AgentActionPending> {
    // While one is waiting for the human, nothing the agent sends replaces it:
    // a new card pushed live could land under a human's cursor mid-click, so
    // they would confirm an action they never read. Checked first, so the
    // answer is the same whatever state the new request is in.
    const waiting = this.pendingAgentAction(chatId, undefined, id);
    if (waiting) return waiting;
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
    const kind = kindOfTarget(grant.lease.targetId);
    const axis = axisFor(kind);
    const level = levelFor(kind, this.readPolicy(chatId).policy);
    if (level === "deny") throw controlError("denied", `${AXIS_LABELS[axis]} is denied for this chat; no GUI action can be performed`);
    const target = this.humanTarget(kind);
    // Prompt and execution share one immutable snapshot: what the human is
    // shown is what runs, even if the caller mutates its object afterwards.
    const request = structuredClone(action) as Record<string, unknown>;
    const summary = describeAgentAction(request, target);
    if (level === "allow") {
      // The human granted unattended control for this chat. All that is left to
      // do is leave a trace of it — an attempt before, and a correction after if
      // it did not happen, because this log is the only account anyone gets and
      // an over-report is the worst way for it to be wrong.
      logUnattendedAction(chatId, id, describeAgentActionForLog(request, target), axis);
      // A stopped turn is not a fault, and it does not arrive as one: `call()`
      // hands back an `isError` result whatever happened, so the abort has to
      // travel with the signal the caller gave us rather than with the error.
      const outcome = (): FailureContext => ({ cancelled: options?.signal?.aborted });
      let result: T;
      try {
        result = await execute(randomUUID(), request);
      } catch (error) {
        logUnattendedFailure(chatId, id, error, outcome(), axis);
        throw error;
      }
      // The MCP layer answers a fault as an `isError` result rather than a
      // throw, so the successful-looking return above is not proof of anything.
      if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true) logUnattendedFailure(chatId, id, result, outcome(), axis);
      return result;
    }
    // Under Ask the action runs later, outside this call, so the strict grammar
    // is applied now: a human must never be asked to approve something the
    // service would reject (the outer `cu_action` schema is a loose record).
    if (!actionSchema.safeParse(request).success)
      throw controlError("invalid_request", "That action does not match the cu_action grammar, so nobody was asked. Fix it and request again.");
    const record: ActionRequest = {
      id: randomUUID(),
      chatId,
      sessionId: id,
      generation,
      frameId,
      action: request,
      signature: grant.signature,
      summary,
      target,
      kind,
    };
    this.actionRequests.set(chatId, record);
    // `kind` travels with the prompt so the stream can keep a sandbox prompt
    // from a tab that does not know the sandbox (utils/sse.ts).
    record.approval = this.raiseApproval(
      chatId,
      { toolName: CU_ACTION_TOOL_NAME, input: { summary, target, action: request, kind, ...this.sandboxPromptVariant(kind) } },
      (approved) => {
        void this.answerAction(record, approved).catch((error) => logComputerUseFailure("cu_action", { chatId, sessionId: id }, error, { escalate: true }));
      },
    );
    return {
      status: "approval_pending",
      requestId: record.id,
      summary,
      message:
        "Approval pending: this target is set to Ask in this chat (Browser Use for the browser, Computer Use for the desktop, Sandbox desktop for the sandbox), so the human has been asked in the chat to confirm this action, and it has NOT been performed. This call does not wait — you will be told the outcome in this chat when they answer, or if the request is withdrawn. It runs only against this frame, so until then cu_observe on this session and cu_action on any session answer approval_pending and do nothing; carry on with other work or end your turn. cu_stop on the session withdraws it, and ends the session (re-enabling needs fresh consent).",
    };
  }
  /**
   * The GUI action this chat has waiting for the human, as the answer to any
   * `cu_action` (and to `cu_observe` on its session) until it is resolved.
   * `sessionId` restricts the question to one session (`cu_observe`);
   * `askedAbout` is the session the agent was trying to use, for the wording.
   *
   * The lock is per chat for actions and per session for observing, on
   * purpose. Observing another session cannot touch the pending frame, so it
   * is allowed. Acting on another session cannot either — but it would raise a
   * second card, and a second card queued behind the first is exactly what
   * lands under the human's cursor when they answer it. One card per chat.
   */
  pendingAgentAction(chatId: string, sessionId?: string, askedAbout?: string): AgentActionPending | undefined {
    const record = this.actionRequests.get(chatId);
    if (!record || (sessionId !== undefined && record.sessionId !== sessionId)) return undefined;
    const same = (askedAbout ?? sessionId) === undefined || (askedAbout ?? sessionId) === record.sessionId;
    return {
      status: "approval_pending",
      alreadyPending: true,
      requestId: record.id,
      sessionId: record.sessionId,
      summary: record.summary,
      message: same
        ? `Nothing new was done or requested: your GUI action request ${record.id} on this session is still waiting for the human, and observing or acting here would invalidate the frame they are being asked about. You will be told the outcome in this chat. Carry on with other work or end your turn; cu_stop on the session withdraws it (and ends the session; re-enabling needs fresh consent).`
        : `Nothing new was requested: your GUI action request ${record.id} on session ${record.sessionId} is still waiting for the human. Only one GUI action can wait per chat, so actions on any session wait until it is resolved; observing other sessions is fine. You will be told the outcome in this chat.`,
    };
  }
  /** Could this request still run if approved now? The same checks approval makes, without side effects on the request. */
  private actionCanStillRun(record: ActionRequest): boolean {
    try {
      if (!this.signatureHolds(record.chatId, record.signature)) return false;
      this.agentLease(record.chatId, record.sessionId, record.generation);
      this.service.assertFrame(controlPrincipal(record.chatId, "agent"), {
        sessionId: record.sessionId,
        generation: record.generation,
        frameId: record.frameId,
      });
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Withdraw a pending GUI action before the human answered it. The card is
   * taken down in any live tab, and the agent gets a ride-along notice with
   * the reason (it was promised an outcome); nothing starts a turn.
   */
  private cancelActionRequest(record: ActionRequest, reason: WithdrawReason, noticeTo = record.chatId) {
    if (this.actionRequests.get(record.chatId) === record) this.actionRequests.delete(record.chatId);
    if (!record.approval?.cancel(WITHDRAW_TEXT[reason].human)) return;
    this.emitControlResult(
      record.chatId,
      CU_ACTION_TOOL_NAME,
      record.approval.requestId,
      `The GUI action request was withdrawn: ${WITHDRAW_TEXT[reason].human}.`,
      record.kind,
    );
    if (reason === WITHDRAWN.agentStop) return;
    this.notify(noticeTo, actionWithdrawnNotice(String(record.action.type), record.id, reason), { wake: false });
  }
  private cancelSessionActionRequest(chatId: string, sessionId: string, reason: WithdrawReason) {
    const record = this.actionRequests.get(chatId);
    if (record?.sessionId === sessionId) this.cancelActionRequest(record, reason);
  }
  /**
   * The agent's own successful `cu_stop` on a session withdraws the action
   * waiting on it. Returns the withdrawn request id, which `cu_stop`'s result
   * carries as `withdrawnRequestId`; no notice, since the agent asked.
   */
  withdrawAgentAction(chatId: string, sessionId: string): string | undefined {
    const record = this.actionRequests.get(chatId);
    if (record?.sessionId !== sessionId) return undefined;
    this.cancelActionRequest(record, WITHDRAWN.agentStop);
    return record.id;
  }
  private async answerAction(record: ActionRequest, approved: boolean): Promise<void> {
    if (this.actionRequests.get(record.chatId) !== record) return;
    this.actionRequests.delete(record.chatId);
    const label = actionLabel(record);
    if (!approved) {
      // Warn, as a denial always has: repeated refusals are a prompt-injection signal.
      logComputerUseFailure("cu_action", { chatId: record.chatId, sessionId: record.sessionId }, controlError("denied", ACTION_DENIED));
      this.emitControlResult(record.chatId, CU_ACTION_TOOL_NAME, record.approval?.requestId, "GUI action refused; it was not performed.", record.kind);
      this.notify(record.chatId, `${noticeHeader("GUI action refused")}\n\nYour ${label}. ${ACTION_DENIED}`);
      return;
    }
    const failure = await this.executeApprovedAction(record);
    this.emitControlResult(
      record.chatId,
      CU_ACTION_TOOL_NAME,
      record.approval?.requestId,
      failure ? `The confirmed GUI action was NOT performed: ${humanActionFailure(failure)}.` : "The confirmed GUI action was performed.",
      record.kind,
    );
    this.notify(
      record.chatId,
      failure
        ? `${noticeHeader("approved GUI action NOT performed")}\n\nThe human approved your ${label}, but it was NOT performed: ${approvedActionFailure(failure)}. ${afterApprovedFailure(failure)}`
        : `${noticeHeader("approved GUI action performed")}\n\nThe human approved your ${label} and it was performed. The screen may have changed: call cu_observe for a fresh frame before your next action.`,
    );
  }
  /**
   * Run a human-approved GUI action — only if it is still the action they were
   * shown, against the screen it was aimed at. Resolves to the failure code, or
   * undefined when it ran.
   *
   * A human can take any amount of time to answer, so everything the request
   * was validated against is re-derived first: the chat's policy signature and
   * level, the grant (expiry, ownership), the lease generation and who holds
   * control (a takeover or resume bumps the generation), and the frame —
   * `assertFrame` fails if the agent observed again, another action consumed
   * the frame, or the session restarted. The service repeats the frame and
   * lease checks at dequeue. If any of it moved, nothing runs.
   *
   * It runs as the agent principal, through the service rather than the MCP
   * hop: there is no tool call to answer any more, and the turn that asked may
   * be long over. The service's own operation timeout and the grant's
   * authorization still apply on every step.
   */
  private async executeApprovedAction(record: ActionRequest): Promise<string | undefined> {
    const { chatId, sessionId, generation, frameId } = record;
    const ids = { chatId, sessionId };
    try {
      const current = this.readPolicy(chatId);
      if (record.signature !== current.signature || levelFor(record.kind, current.policy) === "deny")
        throw controlError("denied", "The chat's control scope changed while this action was awaiting confirmation.");
      const lease = this.agentLease(chatId, sessionId, generation);
      this.service.assertFrame(controlPrincipal(chatId, "agent"), { sessionId, generation, frameId });
      await this.service.act(
        controlPrincipal(chatId, "agent"),
        { ...lease, frameId, actionId: randomUUID(), action: record.action as Action },
        AbortSignal.timeout(APPROVED_ACTION_TIMEOUT_MS),
      );
      log.info(
        `Computer control ${controlIds(ids)} human-approved action performed: ${oneLine(describeAgentActionForLog(record.action, record.target)).slice(0, 500)}`,
      );
      return undefined;
    } catch (error) {
      const code = controlCode(error) || "unavailable";
      // The human's click already returned 200; only the agent and this log
      // learn what happened next. A fault after their yes is never routine.
      logComputerUseFailure("cu_action", ids, error, { escalate: !WORLD_MOVED.has(code) });
      log.info(`Computer control ${controlIds(ids)} human-approved action did NOT run code=${code}`);
      return code;
    }
  }
  /**
   * Withdraw this chat's open agent requests: the human pressed Stop (the
   * stream route's `/stop`), or the chat was rewound, forked or compressed
   * (`chat-supersede.ts`). NOT wired to a run's abort signal: an interrupting
   * send also aborts the run, and a message the human sends while the agent
   * waits is not a withdrawal. An approved enable request still starting is
   * fenced. Each withdrawal leaves a ride-along notice — on `noticeTo`, the
   * chat that carries the conversation on — and none starts a turn.
   */
  withdrawChatRequests(chatId: string, reason: WithdrawReason, noticeTo = chatId) {
    for (const [id, request] of [...this.controlRequests])
      if (request.chatId === chatId && !request.sessionId) this.cancelControlRequest(id, request, reason, noticeTo);
    const action = this.actionRequests.get(chatId);
    if (action) this.cancelActionRequest(action, reason, noticeTo);
  }
  /** The agent's own open requests, for `cu_open`. Host request ids only — never a prompt identity. */
  agentRequests(chatId: string): AgentOpenRequest[] {
    const open: AgentOpenRequest[] = [];
    for (const [id, request] of this.controlRequests)
      if (request.chatId === chatId && !request.sessionId) open.push({ requestId: id, type: "enable_control", kind: viewerKind(request.kind) });
    const action = this.actionRequests.get(chatId);
    if (action) open.push({ requestId: action.id, type: "gui_action", summary: action.summary });
    return open;
  }
  agentLease(chatId: string, id: string, generation: number) {
    const grant = this.grant(chatId, id);
    if (generation !== grant.lease.generation) throw controlError("stale_generation", "Observe current session state before acting");
    if (grant.lease.controller !== "agent") throw controlError("lease_conflict", "The human has control");
    return { sessionId: id, generation, leaseId: grant.lease.leaseId };
  }
  async dispose() {
    clearInterval(this.watchdog);
    for (const request of this.controlRequests.values()) {
      request.abort.abort();
      request.approval?.cancel();
    }
    for (const record of this.actionRequests.values()) record.approval?.cancel();
    this.controlRequests.clear();
    this.grants.clear();
    this.pending.clear();
    this.actionRequests.clear();
    for (const off of this.unsubscribers.values()) off();
    this.unsubscribers.clear();
    await this.service.dispose();
  }
}

/**
 * The variables #587 used to point the *desktop* target at a container. They
 * shipped on main for one change, so a host may still set them. Read as
 * nothing they would silently hand the agent this machine's real X11 session,
 * which the operator set them to avoid; so their presence makes the local
 * desktop unavailable with the rename instead. Keep for at least one release.
 */
export const RENAMED_REMOTE_DESKTOP_VARS = ["CALLBOARD_REMOTE_DESKTOP_URL", "CALLBOARD_REMOTE_DESKTOP_TOKEN", "CALLBOARD_REMOTE_DESKTOP_TOKEN_FILE"] as const;
const RENAMED_REMOTE_DESKTOP_REASON =
  "CALLBOARD_REMOTE_DESKTOP_* was renamed to CALLBOARD_SANDBOX_DESKTOP_*: that container is now the Sandbox desktop target, with its own permission. The desktop target is this machine's display only, and stays unavailable while any CALLBOARD_REMOTE_DESKTOP_* variable is set. Rename them (or unset them to use this machine's display), then restart Callboard.";

/** The local desktop target's driver: this machine's X11 display, and nothing else. */
export function localDesktopDriver(
  pkg: Pick<typeof import("@wolpertingerlabs/computer-use"), "createNativeDesktopDriver">,
  env: NodeJS.ProcessEnv = process.env,
): Driver {
  // `||` semantics, as for the new names: an empty variable is an unset one.
  const renamed = RENAMED_REMOTE_DESKTOP_VARS.filter((name) => env[name]?.trim());
  if (renamed.length) {
    log.error(`${renamed.join(", ")} set: ${RENAMED_REMOTE_DESKTOP_REASON}`);
    return {
      kind: "native-desktop",
      lockDomain: "native-desktop:renamed-variables",
      probe: async () => ({ available: false, kind: "native-desktop", readiness: "setup-required", reason: RENAMED_REMOTE_DESKTOP_REASON, capabilities: [] }),
      open: async () => {
        throw controlError("unsupported", RENAMED_REMOTE_DESKTOP_REASON);
      },
    };
  }
  return pkg.createNativeDesktopDriver({
    enabled: true,
    display: env.CALLBOARD_NATIVE_DISPLAY ?? env.DISPLAY,
    acknowledgeFullDesktopAccess: true,
    permissions: { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" },
  });
}

/** The profile name in a sandbox session's service variant (`<name>@<digest>`), or undefined for the base desktop. */
export function sessionProfileName(variant: unknown): string | undefined {
  return typeof variant === "string" ? /^([a-z][a-z0-9-]{0,30}[a-z0-9])@[0-9a-f]{16}$/.exec(variant)?.[1] : undefined;
}

/** A sandbox target that can never open, and says why. Its own lock domain, so it never contends with a real one. */
function unavailableSandboxDriver(reason: string): Driver {
  return {
    kind: "native-desktop",
    lockDomain: "sandbox-desktop:unavailable",
    probe: async () => ({ available: false, kind: "native-desktop", readiness: "setup-required", reason, capabilities: [] }),
    open: async () => {
      throw controlError("unsupported", reason);
    },
  };
}
const SANDBOX_NOT_CONFIGURED =
  "Sandbox desktop is not configured: it is in endpoint mode, and no endpoint is set on the Callboard service host. Set CALLBOARD_SANDBOX_DESKTOP_URL and CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE for a container you run yourself (packages/computer-use/docker/run.sh), or switch Settings → Sandbox desktop to managed mode.";
const unconfiguredSandboxDriver = () => unavailableSandboxDriver(SANDBOX_NOT_CONFIGURED);
const SANDBOX_TURNED_OFF = "Sandbox desktop is turned off on this Callboard (Settings → Sandbox desktop).";

/**
 * The Sandbox desktop target's driver: whichever mode is in force now —
 * `managed` (a container per session, {@link managedSandboxDriver}), `endpoint`
 * ({@link sandboxDesktopDriver}) or `off` — read at each probe and open, so a
 * mode change in Settings applies without a restart. Every property the host
 * reads by shape (`endpoint`, `identity`, `openedInstance`, `managed`) follows
 * the current mode; in `off` there is no endpoint, so the target is not remote.
 *
 * `lockScope: "session"`: managed sessions are separate containers. An
 * endpoint is one host serving one session at a time, and that host refuses a
 * second `open` itself (`lease_conflict`).
 */
export function sandboxTargetDriver(options: {
  mode: () => SandboxDesktopMode;
  managed: Driver;
  endpoint: Driver;
  info?: () => ComputerUseSandboxInfo;
  containerState?: (sessionId: string) => ComputerUseContainerState | undefined;
  profileForConsent?: (name: string, chatId: string) => Promise<ConsentProfile>;
  sessionProfile?: (sessionId: string) => ComputerUseSandboxProfile | undefined;
}): Driver & Partial<RemoteTarget> & SandboxView {
  const off = unavailableSandboxDriver(SANDBOX_TURNED_OFF);
  const current = (): Driver => {
    const mode = options.mode();
    return mode === "managed" ? options.managed : mode === "endpoint" ? options.endpoint : off;
  };
  const remote = () => remoteTarget(current());
  return {
    kind: "native-desktop",
    lockDomain: "sandbox-desktop",
    lockScope: "session",
    probe: () => current().probe(),
    // A profile is a managed container's image: an endpoint (or off) cannot honour one, so it never opens without it.
    open: (context) =>
      context.variant !== undefined && options.mode() !== "managed"
        ? Promise.reject(controlError("unsupported", "Sandbox profiles need managed mode."))
        : current().open(context),
    get endpoint() {
      return remote()?.endpoint;
    },
    get managed() {
      return remote()?.managed;
    },
    identity: (signal?: AbortSignal) => {
      const target = remote();
      if (!target) return Promise.reject(controlError("unsupported", "The sandbox desktop is not configured on the service host."));
      return target.identity(signal);
    },
    // Each driver knows only the sessions it opened, so ask both: a session
    // opened before a mode change still answers for itself.
    openedInstance: (sessionId: string) =>
      remoteTarget(options.managed)?.openedInstance?.(sessionId) ?? remoteTarget(options.endpoint)?.openedInstance?.(sessionId),
    sandboxMode: () => options.mode(),
    sandboxInfo: () => options.info?.() ?? { mode: options.mode() },
    containerState: (sessionId: string) => options.containerState?.(sessionId),
    ...(options.profileForConsent ? { profileForConsent: options.profileForConsent } : {}),
    sessionProfile: (sessionId: string) => options.sessionProfile?.(sessionId),
  } as Driver & Partial<RemoteTarget> & SandboxView;
}

/**
 * The Sandbox desktop target's driver: a remote driver host — the hardened
 * container in packages/computer-use/docker — named by
 * CALLBOARD_SANDBOX_DESKTOP_URL with its token in
 * CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE (or, discouraged because every child
 * process inherits it, CALLBOARD_SANDBOX_DESKTOP_TOKEN). The host is only a
 * driver: every decision stays in this process, under `sandboxControl`.
 *
 * None of them set gives a target that probes unavailable (`setup-required`)
 * with a reason saying how to set it up. Only some of them set, or a value the
 * remote driver rejects, gives the same with what is wrong — never a fall back
 * to anything else. Containers Callboard starts itself replace these variables
 * in a later change.
 */
export function sandboxDesktopDriver(
  pkg: Pick<typeof import("@wolpertingerlabs/computer-use"), "createRemoteDriver">,
  env: NodeJS.ProcessEnv = process.env,
): Driver {
  // An empty variable is an unset one: `||`, not `??`, so `X=""` never
  // overrides (or half-configures) the others.
  const url = env.CALLBOARD_SANDBOX_DESKTOP_URL?.trim() || undefined;
  const inline = env.CALLBOARD_SANDBOX_DESKTOP_TOKEN?.trim() || undefined;
  const tokenFile = env.CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE?.trim() || undefined;
  if (!url && !inline && !tokenFile) return unconfiguredSandboxDriver();
  try {
    if (inline && tokenFile) throw new Error("Set CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE or CALLBOARD_SANDBOX_DESKTOP_TOKEN, not both.");
    if (!url || !(inline || tokenFile))
      throw new Error("Set CALLBOARD_SANDBOX_DESKTOP_URL and CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE (or _TOKEN) together, or none of them.");
    // A token file is read by the package's readTokenFile at each handshake
    // (so a rotated token is picked up), with symlinks allowed: Kubernetes
    // secrets and some credential stores are symlinks, and this path is the
    // operator's, not the desktop's. A bad file makes the target unavailable
    // with the reason, as a bad setting here does.
    return pkg.createRemoteDriver(inline ? { url, token: inline } : { url, tokenFile: tokenFile! });
  } catch (error) {
    const reason = `Sandbox desktop is misconfigured: ${error instanceof Error ? error.message : "invalid settings"}`;
    log.error(reason);
    return unavailableSandboxDriver(reason);
  }
}

/**
 * Endpoint mode's outbox sync: a session opened on an operator-run driver
 * host is synced like a managed one while it runs, and copied once more when
 * it closes — but nothing is ever removed, paused or kept: the container is
 * the operator's. Its outbox is shared by every chat, so only files new or
 * changed since this session opened are delivered to it. A driver without an
 * outbox (not remote, or not configured) is returned unchanged.
 */
export function withOutboxSync(
  driver: Driver,
  sync: { start(context: DeliveryContext, signal?: AbortSignal): Promise<void>; drain(context: DeliveryContext, signal: AbortSignal): Promise<unknown> },
  owner: (chatId: string) => DeliveryOwner | undefined,
  drainTimeoutMs = 30_000,
): Driver {
  const source = driver as Partial<OutboxSource>;
  if (typeof source.listOutbox !== "function" || typeof source.downloadOutboxFile !== "function") return driver;
  return {
    ...driver,
    async open(context) {
      const session = await driver.open(context);
      let where: DeliveryOwner | undefined;
      try {
        where = context.ownerId ? owner(context.ownerId) : undefined;
      } catch {
        where = undefined;
      }
      const delivery: DeliveryContext = {
        sessionId: context.sessionId,
        chatId: context.ownerId ?? "unknown",
        ...(where?.workspaceId ? { workspaceId: where.workspaceId } : {}),
        ...(where?.folder ? { folder: where.folder } : {}),
        mode: "endpoint",
        source: source as OutboxSource,
      };
      // The baseline (what the shared outbox already holds) is taken before the agent can act.
      await sync
        .start(delivery, AbortSignal.any([context.signal, AbortSignal.timeout(5_000)]))
        .catch((error) => log.warn(`Endpoint outbox sync did not start: ${error instanceof Error ? error.message : "unknown"}`));
      return {
        ...session,
        async close() {
          try {
            await session.close();
          } finally {
            await sync.drain(delivery, AbortSignal.timeout(drainTimeoutMs)).catch(() => {
              /* Recorded in the session's manifest; the files stay in the endpoint's outbox. */
            });
          }
        },
      };
    },
  } as Driver;
}

let hostPromise: Promise<ComputerUseHost> | undefined;
export function getComputerUseHost(): Promise<ComputerUseHost> {
  return (hostPromise ??= (async () => {
    const pkg = await import("@wolpertingerlabs/computer-use");
    const manager = getSandboxManager();
    const drivers = {
      browser: pkg.createBrowserDriver({ network: "unrestricted", executablePath: process.env.CALLBOARD_BROWSER_EXECUTABLE }),
      desktop: localDesktopDriver(pkg),
      sandbox: sandboxTargetDriver({
        mode: () => currentSandboxMode().mode,
        managed: managedSandboxDriver(manager),
        endpoint: withOutboxSync(sandboxDesktopDriver(pkg), getSandboxDeliveries(), chatDeliveryOwner),
        info: () => sandboxInfo(),
        containerState: (sessionId) => manager.containerState(sessionId),
        profileForConsent: (name, chatId) => sandboxProfileForConsent(name, chatId),
        sessionProfile: (sessionId) => manager.profileOf(sessionId),
      }),
    };
    const service = new pkg.ComputerUseService({
      targets: COMPUTER_TARGET_KINDS.map((kind) => ({ id: TARGET_IDS[kind], enabled: true, driver: drivers[kind] })),
      // A sandbox profile's session length comes from its recipe, clamped to the Settings cap (at most 8 hours); every other session keeps 15 minutes.
      maxSessionTtlMs: SANDBOX_DESKTOP_BOUNDS.profileMaxSessionMinutes.max * 60_000,
      authorize: (request) => host?.authorize(request) ?? "deny",
    });
    const host: ComputerUseHost = new ComputerUseHost(service, drivers);
    return host;
  })().catch((error) => {
    hostPromise = undefined;
    throw error;
  }));
}
/** The host if something has already started it; never starts one. For hooks that must stay free when computer control is unused. */
export function peekComputerUseHost(): Promise<ComputerUseHost> | undefined {
  return hostPromise;
}
export async function shutdownComputerUse(): Promise<void> {
  const pending = hostPromise;
  hostPromise = undefined;
  if (pending) await (await pending).dispose();
}
