/**
 * The per-harness extras sub-objects `sendMessage` puts on the query options
 * (`options.codex`, `options.pi`). Each builder
 * is the body of what was an inline `if (providerKind === …)` block in
 * claude.ts, moved verbatim apart from reading its inputs off an explicit
 * context instead of closing over sendMessage's locals.
 *
 * Nothing here mutates shared state: each builder returns its sub-object and
 * the caller assigns it. Log lines keep the "claude" module label they were
 * written under.
 */
import type { AgentSettings, DefaultPermissions, EffortLevel } from "shared/types/index.js";
import type { CodexOptionsExtras } from "../agents/adapters/codex/optionsAdapter.js";
import type { PiAdapterOptions } from "../agents/adapters/pi/PiAdapter.js";
import { getSessionProvider } from "../agents/factory.js";
import { detectCodexOpenRouterEnv } from "../agents/adapters/codex/codexAuth.js";
import { resolveCodexExecutionRoute, type CodexExecutionRoute } from "./codex-execution-route.js";
import { resolveReasoningTarget } from "./reasoning-capabilities.js";
import { getCodexExecutablePath } from "./agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("claude");

/** Everything the per-harness builders read from sendMessage — and nothing else. */
export interface ProviderOptionsContext {
  agentSettings: AgentSettings;
  /** Working directory for the session (may be a worktree). */
  folder: string;
  /** The per-chat model override from chat metadata, when it is a string. */
  chatModel: string | undefined;
  /** The per-chat reasoning effort from chat metadata. */
  chatEffort: EffortLevel | undefined;
  /** Live permission accessor — handed through as a function, never snapshotted (see buildPiExtras). */
  getDefaultPermissions: () => DefaultPermissions | null;
  /** Session registry key at option-build time; used only in log lines. */
  trackingId: string;
}

// For Codex chats, surface the per-provider settings the Codex adapter's
// optionsAdapter looks for (the `codex` extras sub-object). Auth defaults to
// subscription (ChatGPT login via
// $CODEX_HOME/auth.json — no key passed); api-key mode forwards the key/base
// url. CODEX_HOME itself rides in via the subprocess env that
// getApiEnvOverrides() already injected into the query env, so it isn't
// repeated here.
export async function buildCodexExtras(ctx: ProviderOptionsContext & { codexRoute: CodexExecutionRoute | undefined }): Promise<CodexOptionsExtras> {
  const { agentSettings, folder, chatModel, getDefaultPermissions, trackingId } = ctx;
  // Pre-resolved by sendMessage when a stored effort had to be validated; probed here otherwise.
  let codexRoute = ctx.codexRoute;
  const authMode = agentSettings.codexAuthMode ?? "subscription";
  // OpenRouter endpoint routing takes precedence over codexAuthMode: the native
  // Codex harness talks to OpenRouter via the injected config.toml provider
  // block, keyed from OPENROUTER_API_KEY. Credentials may come from the stored
  // key or from an ambient OpenRouter setup — see isCodexRoutedThroughOpenRouter
  // for why the env case additionally requires an explicit endpoint override.
  codexRoute ??= await resolveCodexExecutionRoute(agentSettings, folder);
  const reasoningTarget = await resolveReasoningTarget({ provider: "codex", model: chatModel, cwd: folder, codexRoute }, agentSettings);
  const useOpenRouter = reasoningTarget.injectedOpenRouter;
  // Routing requested with no credentials anywhere — no stored key and no
  // ambient OpenRouter setup — is a misconfiguration rather than a silent
  // fallback onto codexAuthMode.
  if (agentSettings.codexUseOpenRouter && !useOpenRouter && !detectCodexOpenRouterEnv()) {
    const message = "Codex chat selected with OpenRouter routing, but no OpenRouter API key is configured in Settings → API.";
    log.error(message);
    throw new Error(message);
  }
  // api-key mode needs a key; subscription mode draws on the stored login.
  // Skipped entirely when OpenRouter routing is active.
  if (!useOpenRouter && authMode === "api-key" && !agentSettings.codexApiKey?.trim()) {
    const message = "Codex chat selected in api-key mode but OPENAI_API_KEY is not configured in Settings → API.";
    log.error(message);
    throw new Error(message);
  }
  // Per-chat model override (persisted to metadata) takes precedence over the
  // global default. Covers new chats (just written by sendMessage) and resumed chats
  // (loaded from disk).
  // Per-chat override wins; either it or the global default may be a
  // cross-harness alias. A per-chat alias with no codex target falls back to the
  // configured default rather than the SDK's built-in default.
  // Which global default applies is mode-specific: routing through OpenRouter
  // reads codexOpenRouterModel (an OR slug), native Codex reads codexModel (a
  // bare CLI slug). Sharing one field made toggling lossy — see the
  // AgentSettings doc-comment on codexOpenRouterModel.
  const requestedModel = reasoningTarget.model;
  // Per-chat reasoning effort, read back out of metadata — maps onto Codex's
  // modelReasoningEffort in the optionsAdapter.
  const chatEffort = ctx.chatEffort;
  // Permissions collapse onto Codex's sandbox + approval policy at thread
  // start (Codex has no per-call canUseTool hook). Surface them so the
  // optionsAdapter can derive the sandbox tier when no explicit one is set.
  const permissions = getDefaultPermissions() ?? undefined;
  // Which `codex` binary this chat spawns. `undefined` — the answer for every
  // chat before Phase 4, and still the default — leaves the SDK to resolve the
  // platform binary nested under `@openai/codex-sdk`. A configured override
  // that failed its `stat`/execute check also lands here as `undefined`, with
  // a warning already logged by the resolver: a typo in a settings field must
  // not break every Codex chat, and the status card is where it is reported.
  const codexBinary = getCodexExecutablePath(agentSettings);
  const codex: CodexOptionsExtras = {
    authMode,
    ...(codexBinary && { pathOverride: codexBinary }),
    ...(useOpenRouter && { useOpenRouter: true }),
    ...(useOpenRouter && agentSettings.codexOpenRouterBaseUrl?.trim() && { openRouterBaseUrl: agentSettings.codexOpenRouterBaseUrl.trim() }),
    ...(!useOpenRouter && authMode === "api-key" && agentSettings.codexApiKey?.trim() && { apiKey: agentSettings.codexApiKey.trim() }),
    ...(!useOpenRouter && authMode === "api-key" && agentSettings.codexBaseUrl?.trim() && { baseUrl: agentSettings.codexBaseUrl.trim() }),
    ...(requestedModel && { model: requestedModel }),
    ...(agentSettings.codexSandboxMode && { sandboxMode: agentSettings.codexSandboxMode }),
    ...(chatEffort && { reasoningEffort: chatEffort }),
    uiAliasPresence: codexRoute.uiAliasPresence,
    ...(codexRoute.directUiNamespaces && {
      directUiNamespaces: codexRoute.directUiNamespaces,
      directUiCodeModeEnabled: codexRoute.directUiCodeModeEnabled,
      directUiPolicy: codexRoute.directUiPolicy,
    }),
    reasoningRoute: reasoningTarget.route === "openrouter" ? "openrouter" : reasoningTarget.route === "codex" ? "native" : "unknown",
    ...(permissions && { permissions }),
  };
  log.info(
    `Codex chat config — trackingId=${trackingId}, authMode=${useOpenRouter ? "openrouter" : authMode}, ` +
      `model=${requestedModel ?? "(default)"}, effort=${chatEffort ?? "(default)"}, ` +
      `binary=${codexBinary ?? "(bundled)"}, ` +
      `sandbox=${agentSettings.codexSandboxMode ?? "(permission-derived)"}, ` +
      `codexHome=${agentSettings.codexHome?.trim() || "~/.codex"}` +
      `${useOpenRouter ? `, orBaseUrl=${agentSettings.codexOpenRouterBaseUrl?.trim() || "(default)"}` : ""}` +
      `${useOpenRouter && agentSettings.codexOpenRouterApiKey ? `, orKeyTail=…${agentSettings.codexOpenRouterApiKey.trim().slice(-4)}` : ""}` +
      `${!useOpenRouter && authMode === "api-key" && agentSettings.codexApiKey ? `, apiKeyTail=…${agentSettings.codexApiKey.trim().slice(-4)}` : ""}`,
  );
  return codex;
}

// pi chats. Unlike the Codex builder above — which must collapse permissions
// onto a sandbox tier chosen at thread start — pi gates per call through its `tool_call` extension, so the permission
// defaults are only the FIRST half of the decision and anything resolving to
// "ask" escalates through the same `canUseTool` Claude Code uses. pi runs in this
// process and takes its credentials as config fields, falling back to its own
// environment lookup when no key is set, so there is no credential *mode* to
// resolve and no "not configured" error to raise here. One difference is not
// cosmetic: **pi resumes by file path, not by session id**.
//
// `queryOpts.options.resume` carries the id, as it does for every other
// harness. Handing that to pi would silently start a fresh session with the
// chat's history gone, so the id is resolved to a path here and travels in its
// own explicitly named field. `PiAdapter.assertPiResumePath` throws if a value
// that is not an absolute `.jsonl` path ever reaches it.
export async function buildPiExtras(ctx: ProviderOptionsContext & { resumeSessionId: string | undefined; chatId: string | undefined }): Promise<PiAdapterOptions> {
  const { agentSettings, chatModel, getDefaultPermissions, trackingId, resumeSessionId } = ctx;
  const piModel = (await resolveReasoningTarget({ provider: "pi", model: chatModel }, agentSettings)).model;
  const chatEffort = ctx.chatEffort;

  // id → path. A chat whose session file has been removed resolves to nothing;
  // that is a real (if rare) state — the history is genuinely gone — so it
  // starts fresh with a warning rather than failing the turn outright. The
  // thing that must never happen quietly is the *type* confusion above, and
  // that is what throws.
  let piResumePath: string | undefined;
  if (resumeSessionId) {
    const resolved = getSessionProvider("pi")?.resolveSession(resumeSessionId) ?? null;
    if (resolved) {
      piResumePath = resolved.logPath;
    } else {
      log.warn(`pi chat ${ctx.chatId ?? "(new)"} references session ${resumeSessionId} but no session file exists — starting a fresh session`);
    }
  }

  const pi: PiAdapterOptions = {
    ...(agentSettings.piProviderId?.trim() && { providerId: agentSettings.piProviderId.trim() }),
    ...(piModel && { model: piModel }),
    ...(agentSettings.piApiKey?.trim() && { apiKey: agentSettings.piApiKey.trim() }),
    ...(agentSettings.piBaseUrl?.trim() && { baseUrl: agentSettings.piBaseUrl.trim() }),
    ...(chatEffort && { effort: chatEffort }),
    ...(piResumePath && { resumeSessionPath: piResumePath }),
    // The accessor, not its value. sendMessage's `toolPermissionPolicy` holds this
    // same function and calls it per tool call; handing the adapter a
    // snapshot taken here would let pass 1 auto-allow on a policy the user
    // has since tightened, and pass 2 — the one that would have caught it —
    // is only reached when pass 1 says "ask". Two passes, one input, one
    // moment of reading it.
    getPermissions: getDefaultPermissions,
  };
  log.info(
    `pi chat config — trackingId=${trackingId}, provider=${agentSettings.piProviderId?.trim() || "(openrouter)"}, ` +
      `model=${piModel ?? "(provider default)"}, effort=${chatEffort ?? "(default)"}, ` +
      `resume=${piResumePath ? "path resolved" : resumeSessionId ? "UNRESOLVED — fresh session" : "new"}, ` +
      `apiKey=${agentSettings.piApiKey?.trim() ? `…${agentSettings.piApiKey.trim().slice(-4)}` : "(from environment)"}`,
  );
  return pi;
}
