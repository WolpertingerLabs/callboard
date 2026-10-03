/**
 * The per-harness extras sub-objects `sendMessage` puts on the query options
 * (`options.codex`, `options.acp`, `options.cline`, `options.pi`). Each builder
 * is the body of what was an inline `if (providerKind === …)` block in
 * claude.ts, moved verbatim apart from reading its inputs off an explicit
 * context instead of closing over sendMessage's locals.
 *
 * Nothing here mutates shared state: each builder returns its sub-object and
 * the caller assigns it. Log lines keep the "claude" module label they were
 * written under.
 */
import type { AgentSettings, DefaultPermissions, EffortLevel } from "shared/types/index.js";
import type { AcpRunOptions } from "../agents/adapters/acp/AcpAdapter.js";
import type { ClineAdapterOptions } from "../agents/adapters/cline/ClineAdapter.js";
import type { CodexOptionsExtras } from "../agents/adapters/codex/optionsAdapter.js";
import type { PiAdapterOptions } from "../agents/adapters/pi/PiAdapter.js";
import { getSessionProvider } from "../agents/factory.js";
import { detectCodexOpenRouterEnv } from "../agents/adapters/codex/codexAuth.js";
import { resolveCodexExecutionRoute, type CodexExecutionRoute } from "./codex-execution-route.js";
import { resolveReasoningTarget } from "./reasoning-capabilities.js";
import { getCodexExecutablePath, resolveSessionModel } from "./agent-settings.js";
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
  /** Live permission accessor — handed through as a function, never snapshotted (see buildAcpExtras). */
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

// For ACP chats, surface the provider id and the permission defaults the ACP
// adapter needs. Unlike Codex — which must collapse permissions onto a sandbox
// tier chosen at thread start — ACP gates per call, so the defaults are only
// the FIRST half of the decision: the adapter consults them, and anything
// resolving to "ask" escalates through the `canUseTool` already on
// `queryOpts.options` (the same callback Claude Code uses). A model IS passed
// now — ACP exposes models only as a post-session config option, so the
// adapter applies it with `session/set_config_option` after attaching rather
// than requesting it on `session/new`. There is still no effort knob: ACP has
// no reasoning-effort concept at all, so there would be nothing honest to send.
export function buildAcpExtras(ctx: ProviderOptionsContext & { acpProviderId: string | undefined }): AcpRunOptions {
  const { agentSettings, chatModel, getDefaultPermissions, trackingId, acpProviderId } = ctx;
  // The vendor's own model id, e.g. "opencode/nemotron-3-ultra-free". Resolved
  // with the same three-step fallback every other harness uses
  // (resolveSessionModel): a per-chat override wins first — itself alias-aware,
  // so `planner` on the chat resolves through the `acp` alias target — then
  // this vendor's stored default from `agentSettings.acpProviderModels`
  // (looked up by `acpProviderId`, also alias-aware), then nothing at all —
  // the vendor CLI's own configured default stands.
  //
  // The per-vendor lookup exists because "acp" is one kind covering many
  // vendors whose catalogs share nothing: a flat default (like a single alias
  // `acp` target) would apply the same model id to every vendor a user
  // configures, and the wrong one would be refused by that vendor's own CLI
  // rather than silently substituted. `acpProviderModels` is keyed by vendor id
  // for exactly that reason; an alias whose `acp` target only makes sense for
  // one vendor still applies to all of them if used as a per-chat override —
  // that limitation is real and lives on the alias mechanism, not here.
  const acpProviderDefaultModel = acpProviderId ? agentSettings.acpProviderModels?.[acpProviderId] : undefined;
  const acpModel = resolveSessionModel(chatModel, acpProviderDefaultModel, "acp", agentSettings);
  // OpenRouter credential, when the user turned it on. The dedicated key wins,
  // then the account-wide one — unlike the Codex pair, which requires its own,
  // because nothing here rewrites the agent's provider config and there is no
  // reason to make a user re-enter a key they have already given. The adapter
  // still drops it unless the vendor's preset names an env var for it.
  const acpOpenRouterApiKey = agentSettings.acpUseOpenRouter
    ? agentSettings.acpOpenRouterApiKey?.trim() || agentSettings.openRouterApiKey?.trim() || undefined
    : undefined;
  const acp: AcpRunOptions = {
    ...(acpProviderId && { providerId: acpProviderId }),
    ...(acpModel && { model: acpModel }),
    ...(acpOpenRouterApiKey && { openRouterApiKey: acpOpenRouterApiKey }),
    // The accessor, not its value. sendMessage's `toolPermissionPolicy` holds this
    // same function and calls it per tool call; handing the adapter a
    // snapshot taken here would let pass 1 auto-allow on a policy the user
    // has since tightened, and pass 2 — the one that would have caught it —
    // is only reached when pass 1 says "ask". Two passes, one input, one
    // moment of reading it.
    getPermissions: getDefaultPermissions,
  };
  log.info(
    `ACP chat config — trackingId=${trackingId}, providerId=${acpProviderId ?? "(unset)"}, model=${acpModel ?? "(agent default)"}, ` +
      `openRouter=${acpOpenRouterApiKey ? "on" : "off"}`,
  );
  return acp;
}

// For Cline chats, surface the per-provider settings the Cline adapter's
// optionsAdapter looks for. Closest in shape to buildAcpExtras above rather than
// the Codex one: Cline gates per call through `requestToolApproval`, so the
// permission defaults are only the FIRST half of the decision and anything
// resolving to "ask" escalates through the same `canUseTool` Claude Code uses.
//
// Unlike every other provider there is no credential *mode* to resolve and no
// "not configured" error to raise here. `@cline/sdk` runs in this process and
// falls back to its own environment lookup when no key is set, so a user whose
// machine already has ANTHROPIC_API_KEY exported gets a working chat with an
// empty Settings → API form. A genuinely missing credential surfaces as the
// provider's own error on the terminal `result`, which is both more accurate
// and more specific than anything a pre-flight check here could say.
export async function buildClineExtras(ctx: ProviderOptionsContext): Promise<ClineAdapterOptions> {
  const { agentSettings, chatModel, getDefaultPermissions, trackingId } = ctx;
  // Per-chat override wins over the global default; either may be a
  // cross-harness alias, resolved through the same registry as every other
  // harness so `planner` lands on whatever the user pointed the `cline` target
  // at.
  const clineModel = (await resolveReasoningTarget({ provider: "cline", model: chatModel }, agentSettings)).model;
  const chatEffort = ctx.chatEffort;
  const cline: ClineAdapterOptions = {
    ...(agentSettings.clineProviderId?.trim() && { providerId: agentSettings.clineProviderId.trim() }),
    ...(clineModel && { model: clineModel }),
    ...(agentSettings.clineApiKey?.trim() && { apiKey: agentSettings.clineApiKey.trim() }),
    ...(agentSettings.clineBaseUrl?.trim() && { baseUrl: agentSettings.clineBaseUrl.trim() }),
    ...(typeof agentSettings.clineMaxIterations === "number" && { maxIterations: agentSettings.clineMaxIterations }),
    ...(chatEffort && { effort: chatEffort }),
    // The accessor, not its value — see buildAcpExtras above for why. Both
    // permission passes must read the policy at the same moment.
    getPermissions: getDefaultPermissions,
  };
  log.info(
    `Cline chat config — trackingId=${trackingId}, provider=${agentSettings.clineProviderId?.trim() || "(anthropic)"}, ` +
      `model=${clineModel ?? "(provider default)"}, effort=${chatEffort ?? "(default)"}, ` +
      `baseUrl=${agentSettings.clineBaseUrl?.trim() || "(default)"}, ` +
      `apiKey=${agentSettings.clineApiKey?.trim() ? `…${agentSettings.clineApiKey.trim().slice(-4)}` : "(from environment)"}`,
  );
  return cline;
}

// pi chats. Same shape as buildClineExtras above — pi also runs in this process
// and takes its credentials as config fields — with one difference that is not
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
    // The accessor, not its value — both permission passes must read the
    // policy at the same moment. See buildClineExtras above.
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
