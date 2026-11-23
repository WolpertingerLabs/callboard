/**
 * What a chat is asking its human: the blocking prompt slot, and the open
 * computer-control requests beside it.
 *
 * **The slot.** A chat has at most one *blocking* prompt at a time — a tool
 * permission request, an `AskUserQuestion`, or a plan review — parked here as a
 * promise the SSE client resolves through `POST /api/chats/:id/respond`. A
 * harness is suspended on it. `buildCanUseTool` in `claude.ts` is the producer;
 * `respondToPermission` is the human-facing consumer; `/pending` replays the
 * open one after a page refresh.
 *
 * **Open approvals.** Computer control asks for things that a harness must not
 * be suspended on, because a human may take minutes or hours to answer and an
 * MCP tool call cannot be held that long: enabling a target, and each GUI
 * action under Ask. {@link openHumanApproval} raises those. It returns at once,
 * has no timer, and calls its owner back when the human answers; the owner
 * reports the outcome to the agent as a chat notice. These requests live
 * *beside* the slot rather than in it, so one never refuses or displaces a
 * blocking prompt — the agent can still ask its human other questions while a
 * GUI action waits. `/pending` shows the slot first, then the open approvals
 * oldest first; each is answered by its own `requestId`.
 *
 * This module exists so a producer can exist without importing `claude.ts`.
 * `claude.ts` imports `computer-use-tools.ts`, so a computer-use module that
 * reached back into `claude.ts` for this map would close an import cycle.
 * Everything here depends only on the session registry and types.
 *
 * @see openHumanApproval — the producer that is not a harness callback.
 */
import { randomUUID } from "node:crypto";
import type { StreamEvent } from "shared/types/index.js";
import type { PermissionResult } from "../agents/adapters/claude-code/types.js";
import { sessionRegistry } from "./session-registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("pending-requests");

export interface ApprovalCompletion {
  ok: boolean;
  error?: string;
}

export interface PendingRequest {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: readonly unknown[];
  eventType: "permission_request" | "user_question" | "plan_review";
  eventData: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  /**
   * This prompt may be answered ONLY by a signed-in human, never by an API
   * key — see {@link pendingRequestRequiresHuman} for why the distinction
   * exists and where it is enforced.
   *
   * Always set on an {@link openHumanApproval}; on the slot, only for a
   * reviewer hard stop (`claude.ts`). A harness
   * callback's prompt (`buildCanUseTool`) does not set it: those are ordinary
   * tool permissions, and the `/respond` route has always accepted a bearer
   * token for them.
   */
  humanOnly?: true;
  requestId?: string;
  /**
   * Parent chat this prompt was also offered to (`parentAnswers` on, the
   * chat has a parent, not a hard stop). The human prompt is raised as usual;
   * that parent (and only it) may answer it through `respond_to_request` — first answer wins,
   * guarded by `requestId`. See parent-answers.ts.
   */
  offeredToParent?: string;
  /** Permission category the policy assigned, for the parent's authority ceiling. */
  category?: string | null;
  /** The model reviewer's (or pre-check's) reasoning, when one ran and passed the call on. */
  reviewerNotes?: string;
  reviewerVerdict?: "escalate" | "kill";
}

/**
 * chatId (tracking id) → the prompt that chat is blocked on.
 *
 * Exported for `claude.ts`, which owns the harness-callback producer and the
 * temp-id → session-id rekey. Everything else should go through the functions
 * below.
 */
export const pendingRequests = new Map<string, PendingRequest>();

/** Is the human being asked anything in this chat — the blocking slot, or an open approval. */
export function hasPendingRequest(chatId: string): boolean {
  return pendingRequests.has(chatId) || firstOpenApproval(chatId) !== undefined;
}

/**
 * The prompt to show for this chat: the blocking one when there is one (a
 * harness is suspended on it), otherwise the oldest open approval.
 */
export function getPendingRequest(chatId: string): Omit<PendingRequest, "resolve"> | null {
  const p = pendingRequests.get(chatId);
  if (p) {
    const { resolve: _, ...rest } = p;
    return rest;
  }
  const open = firstOpenApproval(chatId);
  return open ? presentOpenApproval(open) : null;
}

/**
 * Is this chat blocked on a prompt only a signed-in human may answer?
 *
 * The distinction is not cosmetic, and getting it wrong once already cost a
 * security property. `POST /api/chats/:id/respond` sits under `requireAuth`,
 * which accepts a Bearer `cbk_` API key as readily as a session cookie. That is
 * correct for an ordinary tool permission — answering "may I run Bash" over the
 * API is a supported, documented workflow.
 *
 * It is NOT correct for the computer-use gate. The endpoint that gate used to
 * live behind — `POST /api/computer-use/:chatId/:sessionId/approve` — carries
 * `requireSessionAuth` + `requireControlOrigin` under the comment "This control
 * plane is for the signed-in human, never an agent API key", because the entire
 * value of a second gate is that it still holds when the first one has passed.
 * An agent that has got hold of an API key (from disk, an env var, a prior
 * chat's output) must not be able to confirm its own GUI action.
 *
 * So the requirement travels with the prompt rather than being re-derived from
 * a tool name at the route: every {@link openHumanApproval} is human-only, and
 * `/respond` refuses a non-session actor for those. A future gate inherits the
 * protection by existing, not by remembering.
 *
 * Pass the `requestId` the answer carries. It decides which prompt the answer
 * would reach — {@link respondToPermission} routes by it — so the check has to
 * ask about the same prompt. An answer that would not reach the slot falls
 * through to the open approvals, and while any exist it is treated as
 * human-only: an API key must not be able to aim a non-matching id at the slot
 * and land on a GUI confirmation instead.
 */
export function pendingRequestRequiresHuman(chatId: string, requestId?: unknown): boolean {
  const slot = pendingRequests.get(chatId);
  if (slot && (requestId === undefined || requestId === slot.requestId)) return slot.humanOnly === true;
  return firstOpenApproval(chatId) !== undefined;
}

/**
 * Take back the offer of a chat's open prompt to its parent (`offeredToParent`),
 * so only the user can answer it from here on. For a chat split off its parent
 * (chat-detach.ts): the prompt was raised while it was a child, and the old
 * parent must not keep the authority to approve it. `keys` are the ids the
 * prompt may be parked under — the chat id and its session id. Returns the
 * parent the offer was withdrawn from, if there was one.
 */
/**
 * Re-address every open prompt offered to `fromIds` (a parent's chat/session
 * ids) to `toChatId` instead — for a parent superseded by a chat that took its
 * place (chat-supersede.ts). Only the offer moves: the prompt stays the child's,
 * the user can still answer it, and the new parent answers within its own
 * permissions exactly as the old one would have. Returns the re-addressed
 * prompts' keys.
 */
export function repointParentOffers(fromIds: string[], toChatId: string): string[] {
  const ids = new Set(fromIds);
  const moved: string[] = [];
  for (const [key, pending] of pendingRequests) {
    if (!pending.offeredToParent || !ids.has(pending.offeredToParent)) continue;
    pending.offeredToParent = toChatId;
    moved.push(key);
    log.info(`[PERM-DIAG] re-addressed ${pending.toolName} prompt on ${key} to parent ${toChatId} — its parent was superseded`);
  }
  return moved;
}

export function withdrawParentOffer(keys: string[]): string | undefined {
  for (const key of keys) {
    const pending = pendingRequests.get(key);
    if (!pending?.offeredToParent) continue;
    const parent = pending.offeredToParent;
    delete pending.offeredToParent;
    log.info(`[PERM-DIAG] withdrew ${pending.toolName} prompt on ${key} from parent ${parent} — chat was split off`);
    return parent;
  }
  return undefined;
}

export function respondToPermission(
  chatId: string,
  allow: boolean,
  updatedInput?: Record<string, unknown>,
  updatedPermissions?: unknown[],
  requestId?: string,
): { ok: boolean; toolName?: string; completion?: Promise<ApprovalCompletion> } {
  if (typeof allow !== "boolean") return { ok: false };
  const pending = pendingRequests.get(chatId);
  // An answer meant for an open approval names it; one that names nothing, or
  // the slot's own id, is for the slot. An old consent must never answer a
  // replacement prompt, so an id that matches neither is refused.
  if (!pending || (requestId !== undefined && requestId !== pending.requestId)) return answerOpenApproval(chatId, allow, requestId);
  if (pending.humanOnly && !requestId) return { ok: false };
  const toolName = pending.toolName;
  pendingRequests.delete(chatId);

  if (allow) {
    // For AskUserQuestion the frontend only sends back the collected `answers`.
    // The SDK tool requires the original `questions` to remain in the input
    // (it builds `{...input, answers}`), so merge rather than replace — otherwise
    // `questions` is undefined and the tool crashes mapping over it.
    const resolvedInput = pending.humanOnly
      ? pending.input
      : updatedInput && pending.eventType === "user_question"
        ? { ...pending.input, ...updatedInput }
        : updatedInput || pending.input;
    pending.resolve({
      behavior: "allow",
      updatedInput: resolvedInput,
      updatedPermissions: (pending.humanOnly ? undefined : updatedPermissions) as never,
    });
  } else {
    pending.resolve({ behavior: "deny", message: "User denied", interrupt: true });
  }
  return { ok: true, toolName };
}

// ---------------------------------------------------------------------------
// Open (non-blocking) human approvals
// ---------------------------------------------------------------------------

export interface HumanApprovalRequest {
  /** Tool name shown in the prompt; also what `/respond` reports back. */
  toolName: string;
  /** Payload the prompt renders. Keep it human-readable, not wire internals. */
  input: Record<string, unknown>;
  /** Trusted host UI discriminator, never derived from tool input. */
  controlRequest?: true;
}

/**
 * Called once, when the human answers. A returned promise is handed to the
 * `/respond` route, which waits for it so the human's click reports a failed
 * startup rather than an early 200. Never called on cancel.
 */
export type HumanApprovalAnswer = (approved: boolean) => Promise<ApprovalCompletion> | void;

export interface OpenHumanApproval {
  /** The prompt identity `/respond` must quote. Never handed to the agent. */
  readonly requestId: string;
  /** Still waiting on the human. */
  isOpen(): boolean;
  /**
   * Withdraw the request — Stop, revoke, a scope change. Idempotent; the
   * answer callback is never called afterwards. Returns whether it was open.
   * `humanReason` (host-fixed, human-facing) is what a late answer to it is
   * told — see {@link recentResolution}.
   */
  cancel(humanReason?: string): boolean;
}

interface OpenApprovalEntry {
  chatId: string;
  toolName: string;
  input: Record<string, unknown>;
  controlRequest: boolean;
  onAnswer: HumanApprovalAnswer;
}

/** requestId → open approval. A Map, so iteration order is creation order. */
const openApprovals = new Map<string, OpenApprovalEntry>();

/**
 * `chatId:requestId` → how a recently closed open approval ended, in
 * human-facing words. Keyed by the chat too, so a request id never answers
 * for another chat's card. Bounded: only a tab still showing the card needs
 * it, and only until it re-reads.
 */
const recentResolutions = new Map<string, string>();
const MAX_RECENT_RESOLUTIONS = 200;
const resolutionKey = (chatId: string, requestId: string) => `${chatId}:${requestId}`;
function rememberResolution(chatId: string, requestId: string, text: string) {
  const key = resolutionKey(chatId, requestId);
  recentResolutions.delete(key);
  recentResolutions.set(key, text);
  while (recentResolutions.size > MAX_RECENT_RESOLUTIONS) recentResolutions.delete(recentResolutions.keys().next().value!);
}

/**
 * Why `chatId`'s open approval `requestId` is no longer open — "it was already
 * answered", "you pressed Stop" — when it closed recently, so a late answer
 * from a tab still showing the card can be told why instead of "refresh".
 */
export function recentResolution(chatId: string, requestId: unknown): string | undefined {
  return typeof requestId === "string" ? recentResolutions.get(resolutionKey(chatId, requestId)) : undefined;
}

/**
 * An open approval opened or closed: bump the metadata version every tab
 * polls (`chat_metadata_updated`, no new stream event), so a tab showing a
 * card that was withdrawn in the background — the watchdog, another tab —
 * re-reads `/pending` even with no stream to tell it.
 */
function signalOpenApprovalsChanged(chatId: string) {
  sessionRegistry.notifyMetadata(chatId, { openApprovals: true });
}

function firstOpenApproval(chatId: string): [string, OpenApprovalEntry] | undefined {
  for (const entry of openApprovals) if (entry[1].chatId === chatId) return entry;
  return undefined;
}

function approvalEventData(requestId: string, entry: OpenApprovalEntry): Record<string, unknown> {
  return {
    toolName: entry.toolName,
    input: entry.input,
    requestId,
    humanOnly: true,
    ...(entry.controlRequest ? { controlRequest: true } : {}),
    // Optional wire field (stream.ts): the agent is not suspended on this
    // prompt, so the tab must not treat the chat as running because of it.
    nonBlocking: true,
  };
}

function presentOpenApproval([requestId, entry]: [string, OpenApprovalEntry]): Omit<PendingRequest, "resolve"> {
  return {
    toolName: entry.toolName,
    input: entry.input,
    eventType: "permission_request",
    eventData: approvalEventData(requestId, entry),
    humanOnly: true,
    requestId,
  };
}

function answerOpenApproval(chatId: string, allow: boolean, requestId: unknown): ReturnType<typeof respondToPermission> {
  // Human-only, so the answer must name the request it is for.
  if (typeof requestId !== "string") return { ok: false };
  const entry = openApprovals.get(requestId);
  if (!entry || entry.chatId !== chatId) return { ok: false };
  openApprovals.delete(requestId);
  rememberResolution(chatId, requestId, "it was already answered");
  signalOpenApprovalsChanged(chatId);
  log.info(`[PERM-DIAG] open approval for ${entry.toolName} on ${chatId} → ${allow ? "approved" : "denied"} by the human`);
  let completion: Promise<ApprovalCompletion> | void;
  try {
    completion = entry.onAnswer(allow);
  } catch (err) {
    log.error(`[PERM-DIAG] answer handler for ${entry.toolName} on ${chatId} threw: ${err instanceof Error ? err.message : String(err)}`);
    completion = Promise.resolve({ ok: false, error: "The answer was recorded, but the request could not be completed. Check the chat for its outcome." });
  }
  return { ok: true, toolName: entry.toolName, ...(allow && completion ? { completion } : {}) };
}

/**
 * Ask the chat's human something without suspending anyone on the answer.
 *
 * The non-blocking counterpart of the slot: same `permission_request` card,
 * same `POST /:id/respond` route, same `FeedbackPanel`. What it deliberately
 * does NOT have is the auto-decide half of `buildCanUseTool` — no
 * `ToolPermissionPolicy`, no `decide()`, no early allow. Nothing a caller passes
 * can make `onAnswer(true)` happen; the only code that calls it is
 * {@link respondToPermission}, reached only from the authenticated human's
 * POST (the route refuses an API key and a cross-origin actor for every
 * request raised here — see {@link pendingRequestRequiresHuman}), and never
 * from a parent chat: `respond_to_request` only sees the slot.
 *
 * There is no timeout. The request stays until the human answers or the owner
 * calls `cancel()`; the owner is responsible for cancelling on Stop, revoke and
 * any change that invalidates what was asked.
 *
 * The live `permission_request` event is sent only when nothing else is on the
 * human's screen — no blocking prompt and no older open approval — so this
 * never covers a question they are reading. Otherwise it waits its turn and the
 * tab finds it on its next `/pending` read, which it makes after each answer.
 */
export function openHumanApproval(chatId: string, request: HumanApprovalRequest, onAnswer: HumanApprovalAnswer): OpenHumanApproval {
  const requestId = randomUUID();
  const entry: OpenApprovalEntry = {
    chatId,
    toolName: request.toolName,
    input: structuredClone(request.input),
    controlRequest: request.controlRequest === true,
    onAnswer,
  };
  const visible = !pendingRequests.has(chatId) && firstOpenApproval(chatId) === undefined;
  openApprovals.set(requestId, entry);
  signalOpenApprovalsChanged(chatId);
  const emitter = sessionRegistry.get(chatId)?.emitter;
  if (visible && emitter) emitter.emit("event", { type: "permission_request", content: "", ...approvalEventData(requestId, entry) } as StreamEvent);
  return {
    requestId,
    isOpen: () => openApprovals.get(requestId) === entry,
    cancel: (humanReason) => {
      if (openApprovals.get(requestId) !== entry) return false;
      openApprovals.delete(requestId);
      rememberResolution(chatId, requestId, humanReason ? `it was withdrawn because ${humanReason}` : "it was withdrawn");
      signalOpenApprovalsChanged(chatId);
      log.info(`[PERM-DIAG] open approval for ${entry.toolName} on ${chatId} withdrawn`);
      return true;
    },
  };
}

/** Test seam: forget every open approval. */
export function clearOpenApprovalsForTest(): void {
  openApprovals.clear();
  recentResolutions.clear();
}
