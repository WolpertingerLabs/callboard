/**
 * One-shot completions on a CHAT'S OWN harness and model.
 *
 * `quickCompletion` is the cheap utility path — titles, branch names — and
 * always runs on the global utility backend (Claude Code's haiku/sonnet/opus
 * tiers, or OpenRouter when the user opted into that). Its model parameter is
 * a tier name, not a model id, so it cannot be pointed at a Codex, Cline or pi
 * chat's model at all.
 *
 * Compression summaries must be written by the model the chat is running on:
 * the user picked it for this conversation, and a summary written by a
 * different, usually smaller model is a summary the chat's model then has to
 * trust. So this runs the chat's own `AgentProvider.query` with the same
 * per-harness option builders `sendMessage` uses (`provider-session-options.ts`),
 * but stripped to a single answer:
 *
 *  - a throwaway working directory (removed afterwards), so no tool the model
 *    reaches for can touch the chat's project and the run is not discovered as
 *    a chat in that folder;
 *  - every permission axis set to `deny` and a `canUseTool` that denies, so a
 *    harness that keeps its built-in tools (Codex, Cline, pi) cannot use them;
 *    Claude Code additionally gets `tools: []` and no settings sources;
 *  - no resume, and the instructions carried in the prompt itself, so it does
 *    not depend on each harness's system-prompt plumbing.
 *
 * Fallbacks, per harness:
 *  - claude-code: `persistSession: false` — nothing is written.
 *  - codex, cline, pi: each persists every run, and has no "don't" switch. The
 *    session file is deleted through its own SessionProvider once the run ends
 *    (by the `session_started` id); if the run never reports one, the file
 *    stays behind under the throwaway cwd, which discovery ignores.
 *  - acp: refused — an ACP vendor is a process we would have to spawn and
 *    attach to for one answer, and supersede/compress refuses ACP chats anyway.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DefaultPermissions, EffortLevel } from "shared/types/index.js";
import { getAgentProvider, getSessionProvider } from "../agents/factory.js";
import type { InternalProviderKind } from "../agents/ports/AgentProvider.js";
import { sanitizeInheritedAgentEnv } from "../agents/agentEnvPolicy.js";
import { getAgentSettings, getApiEnvOverrides, resolveModelAlias } from "./agent-settings.js";
import { getClaudeCodeExecutablePath } from "./claude-binary.js";
import { buildClineExtras, buildCodexExtras, buildPiExtras, type ProviderOptionsContext } from "./provider-session-options.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("chat-model-completion");

const DENY_ALL: DefaultPermissions = { fileRead: "deny", fileWrite: "deny", codeExecution: "deny", webAccess: "deny", computerControl: "deny" };

/** Generous: a long span on a slow reasoning model can take minutes. */
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;

export interface ChatModelCompletionOptions {
  provider: InternalProviderKind;
  /** The chat's `metadata.model` — alias-aware, resolved per harness exactly as a chat turn resolves it. */
  model?: string;
  /** The chat's `metadata.effort`, for the reasoning-capable harnesses. */
  effort?: EffortLevel;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ChatModelCompletionError extends Error {}

/** Run `prompt` once on the chat's harness/model and return the assistant's text. */
export async function runChatModelCompletion(opts: ChatModelCompletionOptions): Promise<string> {
  const { provider } = opts;
  if (provider === "acp") throw new ChatModelCompletionError("One-shot completions are not supported for ACP chats");
  if (opts.signal?.aborted) throw new ChatModelCompletionError("Cancelled before it started");

  const agentSettings = getAgentSettings();
  const workDir = mkdtempSync(join(tmpdir(), "callboard-chat-completion-"));
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abortController.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const options: Record<string, unknown> = {
    abortController,
    cwd: workDir,
    maxTurns: 1,
    env: {
      ...sanitizeInheritedAgentEnv(process.env),
      ...getApiEnvOverrides(agentSettings),
      CLAUDECODE: undefined,
    },
    canUseTool: async () => ({ behavior: "deny", message: "No tools are available for this request — answer in text." }),
  };

  if (provider === "claude-code") {
    const model = opts.model?.trim() ? resolveModelAlias(opts.model.trim(), "claude-code", agentSettings) : undefined;
    const claudeExecutable = await getClaudeCodeExecutablePath();
    Object.assign(options, {
      ...(model && { model }),
      ...(claudeExecutable && { pathToClaudeCodeExecutable: claudeExecutable }),
      tools: [],
      allowedTools: [],
      settingSources: [],
      persistSession: false,
      permissionMode: "default",
    });
  } else {
    const ctx: ProviderOptionsContext = {
      agentSettings,
      folder: workDir,
      chatModel: opts.model,
      chatEffort: opts.effort,
      getDefaultPermissions: () => DENY_ALL,
      trackingId: "chat-model-completion",
    };
    if (provider === "codex") options.codex = await buildCodexExtras({ ...ctx, codexRoute: undefined });
    if (provider === "cline") options.cline = await buildClineExtras(ctx);
    if (provider === "pi") options.pi = await buildPiExtras({ ...ctx, resumeSessionId: undefined, chatId: undefined });
  }

  const texts: string[] = [];
  let sessionId: string | null = null;
  let failure: string | undefined;
  try {
    const conversation = getAgentProvider(provider).query({ prompt: opts.prompt, options });
    for await (const event of conversation) {
      if (event.type === "session_started") sessionId = event.sessionId;
      else if (event.type === "text" && event.content.trim()) texts.push(event.content.trim());
      else if (event.type === "result" && event.status === "error") failure = event.reason || "the model returned an error";
    }
  } catch (err) {
    if (abortController.signal.aborted) throw new ChatModelCompletionError(opts.signal?.aborted ? "Cancelled" : "The model took too long to answer");
    throw new ChatModelCompletionError((err as Error).message || String(err));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    if (provider !== "claude-code" && sessionId) {
      try {
        getSessionProvider(provider)?.deleteSessionFiles(sessionId);
      } catch (err) {
        log.warn(`Could not delete the ${provider} session ${sessionId} a one-shot completion left: ${(err as Error).message}`);
      }
    }
    rmSync(workDir, { recursive: true, force: true });
  }

  const text = texts.join("\n\n").trim();
  if (!text) throw new ChatModelCompletionError(failure ? `The model did not answer: ${failure}` : "The model returned no text");
  return text;
}
