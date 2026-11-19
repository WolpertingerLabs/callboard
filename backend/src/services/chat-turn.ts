/**
 * Start a user turn in an EXISTING chat — the body of `POST /:id/message`,
 * shared with routes that start a turn on the user's behalf (an aside's first
 * question, `POST /:id/fork` with `prompt`).
 *
 * Runs every check a send runs, in the same order — native-child control,
 * retired harness, model/effort, the chat-context fence, branch drift — then
 * persists the per-message settings and calls `sendMessage`. A refusal comes
 * back as `{ ok: false, status, body }` for the caller to send; exceptions
 * (`ChatContextChangedError`, `RetiredProviderError`, a failed start) are
 * thrown for the caller to map, exactly as the message route maps them.
 */
import type { EventEmitter } from "events";
import { isRetiredProvider, RETIRED_PROVIDER_LABELS } from "../agents/ports/AgentProvider.js";
import { assertReasoningEffort } from "./reasoning-capabilities.js";
import { assertNativeAgentControllable } from "./codex-native-agents.js";
import { sendMessage, type SendMessageOptions } from "./claude.js";
import { loadImageBuffers } from "./image-storage.js";
import { chatFileService } from "./chat-file-service.js";
import { getGitInfo } from "../utils/git.js";
import { assertChatContextUnchanged, chatContextFingerprint } from "../utils/chat-context.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { findChatForStatus, withSessionProvider } from "../utils/chat-lookup.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("chat-turn");

export interface ChatTurnRequest {
  chatId: string;
  prompt: string;
  imageIds?: string[];
  activePlugins?: string[];
  maxTurns?: number;
  /** Proceed even though the branch changed since the chat's last message. */
  acknowledgeBranchDrift?: boolean;
  /** Per-chat model override to persist; empty string clears it. */
  model?: unknown;
  /** Per-chat effort override to persist; empty string clears it. */
  effort?: unknown;
  /** Per-message override of the chat's persisted setting. */
  requireExplicitCompletion?: unknown;
  chatView?: SendMessageOptions["chatView"];
}

export type ChatTurnResult = { ok: true; emitter: EventEmitter } | { ok: false; status: number; body: Record<string, unknown> };

const NOTHING_TO_SEND = { error: "prompt is required" };

export async function startChatTurn(req: ChatTurnRequest): Promise<ChatTurnResult> {
  const { chatId, prompt, imageIds, activePlugins, maxTurns, acknowledgeBranchDrift, model, effort, requireExplicitCompletion, chatView } = req;
  try {
    assertNativeAgentControllable(chatId);
  } catch (error) {
    return { ok: false, status: 409, body: { error: "native_child_read_only", message: (error as Error).message } };
  }

  // ── Branch drift guard ──────────────────────────────────────
  // If the git branch changed since the last message in this chat,
  // block unless the client explicitly acknowledges.
  const storedChat = chatFileService.getChat(chatId);
  const expectedContext = chatContextFingerprint(storedChat);
  const storedMeta = parseChatMetadata(storedChat?.metadata);
  const needsProvenance = !storedChat || storedMeta.provider == null;
  const chatRecord = needsProvenance ? (findChatForStatus(chatId) ?? storedChat) : storedChat;
  if (!chatRecord) return { ok: false, status: 404, body: { error: "Chat not found" } };
  if (chatRecord._provider_resolution_error) return { ok: false, status: 409, body: { error: chatRecord._provider_resolution_error } };
  const meta = parseChatMetadata(chatRecord.metadata);
  if (isRetiredProvider(meta.provider)) {
    return {
      ok: false,
      status: 410,
      body: { error: `This chat ran on ${RETIRED_PROVIDER_LABELS[meta.provider]}, which has been removed. It cannot be resumed.`, code: "retired_provider" },
    };
  }
  const ownershipExpectation = { sessionId: chatRecord.session_id, provider: meta.provider };
  // Validate the merged configuration before any metadata changes. Clearing
  // effort permits recovery from stale saved overrides without weakening it.
  if (model !== undefined || effort !== undefined) {
    try {
      await assertReasoningEffort({
        cwd: chatRecord.folder,
        provider: meta.provider,
        model: typeof model === "string" ? model.trim() || undefined : meta.model,
        effort: effort !== undefined ? effort : meta.effort,
      });
    } catch (error) {
      return { ok: false, status: 400, body: { error: (error as Error).message } };
    }
  }
  // Validation awaits may let another run rotate this chat or change its
  // execution settings. Never repair an old identity or validate one owner
  // and then write settings onto another. Unrelated metadata may still merge.
  const fresh = chatFileService.getChat(chatRecord.id);
  assertChatContextUnchanged(expectedContext, fresh);
  // Retain validated provenance even if the unpersisted rollout disappears.
  try {
    assertNativeAgentControllable(chatId, ownershipExpectation);
  } catch (error) {
    return { ok: false, status: 409, body: { error: "native_child_read_only", message: (error as Error).message } };
  }
  const currentBranch = getGitInfo(chatRecord.folder).branch;

  if (meta.lastBranch && currentBranch && meta.lastBranch !== currentBranch && !acknowledgeBranchDrift) {
    log.warn(`Branch drift detected for chat ${chatId}: "${meta.lastBranch}" → "${currentBranch}"`);
    return {
      ok: false,
      status: 409,
      body: {
        error: "branch_drift",
        message: `The branch has changed from "${meta.lastBranch}" to "${currentBranch}" since your last message. Do you want to continue on "${currentBranch}"?`,
        lastBranch: meta.lastBranch,
        currentBranch,
      },
    };
  }

  // Settings this message persists, before sendMessage re-reads
  // initialMetadata from disk:
  //  - lastBranch → the current branch (the drift check above has passed);
  //  - model → a per-chat override, honored for every harness (each stores
  //    the identifier its own engine accepts);
  //  - effort → a per-chat reasoning-effort override.
  // An empty model/effort clears the override so the chat falls back to the
  // provider's global default: the key is set to undefined, and
  // JSON.stringify drops undefined keys.
  const fields: Record<string, unknown> = {};
  if (currentBranch) fields.lastBranch = currentBranch;
  if (typeof model === "string") {
    const trimmed = model.trim();
    fields.model = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof effort === "string") fields.effort = effort.trim() || undefined;

  // One write, not up to four read-modify-writes of the same file. Adopt /
  // repair only after preflight succeeds. In particular, malformed legacy
  // JSON must not cause updateChatMetadata to silently drop the validated
  // effort/model — so the settings ride along with the normalizing write.
  // Merge fresh fields and preserve explicit routing.
  if (!fresh) {
    // The original discovery snapshot is only valid for a still-absent record.
    chatFileService.upsertChat(chatRecord.id, chatRecord.folder, chatRecord.session_id, { metadata: JSON.stringify({ ...meta, ...fields }) });
  } else if (needsProvenance) {
    const routing = parseChatMetadata(withSessionProvider("{}", meta.provider));
    chatFileService.updateChatMetadata(fresh.id, { ...routing, ...fields }, { normalizeLegacy: true });
  } else if (Object.keys(fields).length > 0) {
    chatFileService.updateChatMetadata(chatId, fields);
  }
  // ── End branch drift guard ──────────────────────────────────

  const imageMetadata = imageIds?.length ? loadImageBuffers(imageIds) : [];
  if (!prompt && imageMetadata.length === 0) return { ok: false, status: 400, body: NOTHING_TO_SEND };

  const emitter = await sendMessage({
    chatView,
    chatId,
    prompt,
    imageMetadata: imageMetadata.length > 0 ? imageMetadata : undefined,
    activePlugins,
    maxTurns,
    // Per-message override; omitted (undefined) inherits the chat's
    // persisted requireExplicitCompletion setting.
    ...(typeof requireExplicitCompletion === "boolean" && { requireExplicitCompletion }),
  });
  return { ok: true, emitter };
}
