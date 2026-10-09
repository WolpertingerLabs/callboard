/**
 * "Parent can answer" — an ancestor Callboard chat answering a descendant's
 * permission prompt.
 *
 * ## Design: offered, not hidden
 *
 * The prompt is raised for the human exactly as today (`buildCanUseTool`,
 * claude.ts) and is visible and answerable the whole time. Offering it to the
 * parent only adds a second answerer: the parent may answer through
 * `respond_to_request`, and whichever answer lands first wins — both go
 * through the same `pendingRequests` slot, and a stale `requestId` matches
 * nothing. So there is no hidden prompt, no parent timeout and no timer race:
 * a parent that never answers simply leaves the prompt with the human, who
 * would have seen it anyway.
 *
 * ## Who may answer what
 *
 * {@link respondAsAncestor} refuses unless all of these hold:
 *  - the prompt exists and `requestId` is the one currently open;
 *  - it is an ordinary tool permission (`permission_request`) that was
 *    offered (`offeredToParent` is set — so the child had `parentAnswers` on
 *    when it was raised, and it was not a hard stop), and it is not
 *    `humanOnly` (the computer-use gate and reviewer hard stops are for a
 *    signed-in human only);
 *  - the child still has `parentAnswers` on (re-read live, so turning it off
 *    takes effect for prompts already open);
 *  - the caller is an ancestor of the child;
 *  - to APPROVE, the caller itself holds `allow` on the call's axis
 *    (`parentApprovalRefusal`, permission-ceiling.ts). Denying is always open.
 *
 * `AskUserQuestion` / `ExitPlanMode` are never offered: they are questions for
 * the user, and a parent answering them would be the agent talking to itself.
 *
 * ## Notification
 *
 * When a prompt is offered, {@link notifyParentOfChildPrompt} ends any
 * interruptible `wait` the parent is blocked in, with a note telling it which
 * child needs what and to call `list_pending_requests`. A parent that is busy
 * with something else, idle or finished is NOT woken or resumed: auto-resuming
 * a finished chat to answer prompts would start an unattended turn the user did
 * not ask for, so in that case the prompt simply stays with the human.
 */
import type { DefaultPermissions } from "shared/types/index.js";
import { normalizeReviewSettings } from "shared/types/index.js";
import { pendingRequests, type PendingRequest } from "./pending-requests.js";
import { parentApprovalRefusal } from "./permission-ceiling.js";
import { chatFileService } from "./chat-file-service.js";
import { getParentChatId } from "./chat-lineage.js";
import { listActivities, releaseActivity } from "./chat-activity.js";
import { sessionRegistry } from "./session-registry.js";
import { parseChatMetadataRecord } from "../utils/chat-metadata.js";
import type { StreamEvent } from "shared/types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("parent-answers");

const MAX_ANCESTRY_DEPTH = 32;

/** Prefix of the `releasedBy` reason a child prompt ends a parent's `wait` with. */
export const CHILD_PROMPT_RELEASE_PREFIX = "child_permission:";

function readMeta(chatId: string): Record<string, unknown> | null {
  const chat = chatFileService.getChat(chatId);
  return chat ? parseChatMetadataRecord(chat.metadata) : null;
}

/**
 * Is `ancestorId` an ancestor of the prompt's chat? The first hop is the
 * parent recorded on the prompt itself — a brand-new child is still on a temp
 * tracking id with no record to read — and the rest walks stored records.
 */
export function isAncestorOf(ancestorId: string, firstParentId: string | undefined): boolean {
  let current = firstParentId;
  const seen = new Set<string>();
  for (let depth = 0; current && depth < MAX_ANCESTRY_DEPTH && !seen.has(current); depth++) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = getParentChatId(readMeta(current));
  }
  return false;
}

/** Live read of a child's `parentAnswers`. A still-temp child has no record yet; its offer stands. */
function childStillOffers(chatId: string): boolean {
  const meta = readMeta(chatId);
  return meta === null ? true : normalizeReviewSettings(meta).parentAnswers;
}

function isOfferedTo(entry: PendingRequest, chatId: string, callerChatId: string): boolean {
  return (
    entry.eventType === "permission_request" &&
    !entry.humanOnly &&
    !!entry.offeredToParent &&
    isAncestorOf(callerChatId, entry.offeredToParent) &&
    childStillOffers(chatId)
  );
}

export interface AnswerableRequest {
  chatId: string;
  title: string | null;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  category: string | null;
  reviewerNotes?: string;
}

/** Open prompts of `callerChatId`'s descendants that the caller may answer. */
export function listAnswerableRequests(callerChatId: string): AnswerableRequest[] {
  const rows: AnswerableRequest[] = [];
  for (const [chatId, entry] of pendingRequests) {
    if (!entry.requestId || !isOfferedTo(entry, chatId, callerChatId)) continue;
    const title = readMeta(chatId)?.title;
    rows.push({
      chatId,
      title: typeof title === "string" ? title : null,
      requestId: entry.requestId,
      toolName: entry.toolName,
      input: entry.input,
      category: entry.category ?? null,
      ...(entry.reviewerNotes && { reviewerNotes: entry.reviewerNotes }),
    });
  }
  return rows;
}

export type AncestorAnswerResult =
  | { ok: true; chatId: string; requestId: string; toolName: string; allowed: boolean }
  | { ok: false; error: string; message: string };

/**
 * Answer a descendant's prompt on behalf of the calling chat. See the module
 * header for every check; each refusal names what failed.
 */
export function respondAsAncestor(args: {
  callerChatId: string;
  callerPermissions: DefaultPermissions | null;
  chatId: string;
  requestId: string;
  allow: boolean;
  reason: string;
}): AncestorAnswerResult {
  const { callerChatId, chatId, requestId, allow } = args;
  const reason = args.reason.trim().slice(0, 1000) || "(no reason given)";
  const entry = pendingRequests.get(chatId);
  if (!entry) return { ok: false, error: "not_found", message: `Chat "${chatId}" has no open prompt. It may have been answered already — call list_pending_requests again.` };
  if (entry.requestId !== requestId) {
    return { ok: false, error: "stale_request", message: "That requestId is not the prompt currently open in that chat (it was answered or replaced). Call list_pending_requests again." };
  }
  if (entry.humanOnly) {
    return {
      ok: false,
      error: "human_only",
      message:
        entry.reviewerVerdict === "kill"
          ? "This prompt is a reviewer HARD STOP (suspected prompt injection or a self-destructive act). Only the signed-in user may answer it."
          : "This prompt may be answered only by the signed-in user.",
    };
  }
  if (entry.eventType !== "permission_request") return { ok: false, error: "not_a_permission", message: "Only tool-permission prompts can be answered by a parent chat; questions and plan reviews are for the user." };
  if (!entry.offeredToParent || !childStillOffers(chatId)) {
    return { ok: false, error: "parent_answers_off", message: `Chat "${chatId}" does not have "parent can answer" turned on, so its prompts are for the user only.` };
  }
  if (!isAncestorOf(callerChatId, entry.offeredToParent)) {
    return { ok: false, error: "not_descendant", message: `Chat "${chatId}" is not a descendant of this chat, so this chat may not answer its prompts.` };
  }
  if (allow) {
    const refusal = parentApprovalRefusal(entry.category, args.callerPermissions);
    if (refusal) return { ok: false, error: "permission_ceiling", message: refusal };
  }

  // First answer wins: the slot and the requestId were checked synchronously
  // above, and deleting the entry here is what makes a later human click 409.
  pendingRequests.delete(chatId);
  if (allow) {
    entry.resolve({ behavior: "allow", updatedInput: entry.input });
  } else {
    // Not an interrupt: the agent should read the reason and adapt, the same
    // as a reviewer deny — not stop dead as on a human "deny".
    entry.resolve({ behavior: "deny", message: `Denied by parent chat ${callerChatId}: ${reason}`, interrupt: false });
  }
  log.info(`[PERM-DIAG] tool=${entry.toolName} on ${chatId} answered by ancestor ${callerChatId} → ${allow ? "allow" : "deny"} (${reason.slice(0, 200)})`);
  sessionRegistry.get(chatId)?.emitter?.emit("event", {
    type: "tool_result",
    content: "",
    toolName: entry.toolName,
    promptResolved: { requestId, allowed: allow, message: `${allow ? "Allowed" : "Denied"} by parent chat: ${reason}` },
  } as StreamEvent);
  return { ok: true, chatId, requestId, toolName: entry.toolName, allowed: allow };
}

/**
 * Tell the parent a child prompt is waiting: end every interruptible `wait`
 * it is blocked in. Returns whether a wait was ended (false = the parent was
 * not waiting, and the prompt stays with the human).
 */
export function notifyParentOfChildPrompt(parentChatId: string, childChatId: string, toolName: string): boolean {
  let released = false;
  for (const activity of listActivities(parentChatId)) {
    if (activity.kind !== "wait" || !activity.interruptible) continue;
    const outcome = releaseActivity(parentChatId, activity.id, `${CHILD_PROMPT_RELEASE_PREFIX}${childChatId}:${toolName}`);
    if (outcome.ok) released = true;
  }
  log.info(`[PERM-DIAG] offered ${toolName} prompt of ${childChatId} to parent ${parentChatId} (wait ${released ? "ended early" : "not active — prompt stays with the user"})`);
  return released;
}

/** The `wait` note for a wait ended by {@link notifyParentOfChildPrompt}, or null for any other reason. */
export function childPromptWaitNote(releasedBy: string | undefined): string | null {
  if (!releasedBy?.startsWith(CHILD_PROMPT_RELEASE_PREFIX)) return null;
  const rest = releasedBy.slice(CHILD_PROMPT_RELEASE_PREFIX.length);
  const split = rest.indexOf(":");
  const childId = split >= 0 ? rest.slice(0, split) : rest;
  const tool = split >= 0 ? rest.slice(split + 1) : "a tool";
  return (
    `This wait ended early because child chat ${childId} needs approval for ${tool}. Call list_pending_requests to see it, then ` +
    "respond_to_request to allow or deny it (you may only allow what this chat itself is allowed to do). The user can also answer it; whoever answers first wins."
  );
}
