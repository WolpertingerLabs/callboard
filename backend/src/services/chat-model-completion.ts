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
 *  - no tools the model can use, by whatever means each harness offers — see
 *    "Lockdown, per harness" below;
 *  - no resume, and the instructions carried in the prompt itself, so the
 *    answer does not depend on each harness's system-prompt plumbing. A
 *    `systemPrompt`, when given, REPLACES the harness's agent prompt where the
 *    harness takes one (Claude Code, Codex, Cline) — without it Claude Code's
 *    default prompt describes the throwaway cwd and platform, and the model
 *    dutifully repeats that into its answer. pi has no system-prompt option,
 *    so it gets the prompt alone.
 *
 * Lockdown, per harness. Every harness also gets every permission axis set to
 * `deny` and a `canUseTool` that denies; what that achieves differs:
 *  - claude-code: no tools at all (`tools: []`, no allowed tools, no settings
 *    sources, so no user MCP servers, hooks or plugins).
 *  - codex: Codex has no per-call hook, so permissions only pick a sandbox at
 *    thread start — and a global `codexSandboxMode` setting would override
 *    them. The run uses the adapter's `lockdown` mode instead: sandbox forced
 *    to `read-only` with approval `never` regardless of settings, the
 *    tool-carrying feature flags off (shell, apps, plugins, multi-agent,
 *    browser/computer use, …), web search disabled, and every MCP server in
 *    the user's effective config disabled by name. Its server list comes from
 *    the CLI's config/read; when that cannot be read the run is refused rather
 *    than started with servers live. Verified against codex-cli 0.153.4: asked
 *    to run a shell command, the locked-down model had no tool to do it with.
 *  - cline: every tool call goes through `requestToolApproval`, which reads
 *    the deny-all axes and refuses; tools stay in the model's list but every
 *    call is refused. `maxIterations` is capped so a model that keeps trying
 *    cannot loop.
 *  - pi: deny-all removes every built-in tool from the session
 *    (`buildToolFilters`), and the per-call gate refuses anything else
 *    (extension tools included).
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
import type { AgentSettings, DefaultPermissions, EffortLevel } from "shared/types/index.js";
import { getAgentProvider, getSessionProvider } from "../agents/factory.js";
import type { InternalProviderKind } from "../agents/ports/AgentProvider.js";
import { sanitizeInheritedAgentEnv } from "../agents/agentEnvPolicy.js";
import { getAgentSettings, getApiEnvOverrides, resolveModelAlias } from "./agent-settings.js";
import { getClaudeCodeExecutablePath } from "./claude-binary.js";
import { buildClineExtras, buildCodexExtras, buildPiExtras, type ProviderOptionsContext } from "./provider-session-options.js";
import { resolveCodexExecutionRoute } from "./codex-execution-route.js";
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
  /** Replaces the harness's own agent system prompt where it accepts one. */
  systemPrompt?: string;
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
    ...(opts.systemPrompt && { systemPrompt: opts.systemPrompt }),
  };

  const texts: string[] = [];
  let sessionId: string | null = null;
  let failure: string | undefined;
  try {
    await addHarnessOptions(options, opts, agentSettings, workDir);
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

/** Iteration cap for a Cline summary run: one answer, with room for a refused tool call or two. */
const CLINE_MAX_ITERATIONS = 3;

/** The per-harness half of the options, locked down as the header describes. */
async function addHarnessOptions(
  options: Record<string, unknown>,
  opts: ChatModelCompletionOptions,
  agentSettings: AgentSettings,
  workDir: string,
): Promise<void> {
  const { provider } = opts;
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
    return;
  }
  const ctx: ProviderOptionsContext = {
    agentSettings,
    folder: workDir,
    chatModel: opts.model,
    chatEffort: opts.effort,
    getDefaultPermissions: () => DENY_ALL,
    trackingId: "chat-model-completion",
  };
  if (provider === "codex") {
    const codexRoute = await resolveCodexExecutionRoute(agentSettings, workDir);
    if (!codexRoute.mcpServerNames) {
      throw new ChatModelCompletionError("Could not read the Codex configuration, so its MCP servers could not be switched off for the summary run");
    }
    const codex = await buildCodexExtras({ ...ctx, codexRoute });
    // The global sandbox setting must not reach a tool-less run; lockdown
    // forces read-only/never in the adapter, and the explicit tier is dropped
    // here too so nothing downstream reads it.
    delete codex.sandboxMode;
    options.codex = { ...codex, permissions: DENY_ALL, lockdown: { mcpServerNames: codexRoute.mcpServerNames } };
  }
  if (provider === "cline") {
    options.cline = { ...(await buildClineExtras(ctx)), maxIterations: CLINE_MAX_ITERATIONS, ...(opts.systemPrompt && { systemPrompt: opts.systemPrompt }) };
  }
  if (provider === "pi") options.pi = await buildPiExtras({ ...ctx, resumeSessionId: undefined, chatId: undefined });
}
