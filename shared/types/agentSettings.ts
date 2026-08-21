import type { ModelAlias } from "./modelAlias.js";

export interface AgentSettings {
  /** @deprecated Use localMcpConfigDir / remoteMcpConfigDir instead. Kept as fallback. */
  mcpConfigDir?: string;

  /** Absolute path to the .drawlatch.local/ directory for local mode */
  localMcpConfigDir?: string;

  /** Absolute path to the .drawlatch.remote/ directory for remote mode */
  remoteMcpConfigDir?: string;

  /** Proxy mode: 'local' runs in-process, 'remote' connects to external server */
  proxyMode?: "local" | "remote";

  // ── Default enrolled caller for regular (non-agent) sessions ──────
  // Regular, human-operated sessions have no agent to grant them a drawlatch
  // caller, so they borrow a configured "default" caller instead. These fields
  // hold the chosen caller alias per proxy mode. Semantics:
  //   - undefined  → not configured; fall back to the built-in "default" caller
  //                  if it is still enrolled (legacy / out-of-box behavior).
  //   - ""         → explicitly no default; regular sessions get NO proxy access.
  //   - "<alias>"  → use that enrolled caller for regular sessions in this mode.

  /** Default caller alias for regular sessions in local proxy mode. */
  defaultCallerLocal?: string;

  /** Default caller alias for regular sessions in remote proxy mode. */
  defaultCallerRemote?: string;

  /** URL of the remote MCP secure proxy server (used in 'remote' mode only) */
  remoteServerUrl?: string;

  /** Enable cloudflared tunnel for webhook event ingestion (local mode only) */
  tunnelEnabled?: boolean;

  // ── Remote access (expose callboard's web UI to the internet) ─────
  // Distinct from `tunnelEnabled` above: that tunnels the drawlatch daemon for
  // webhook ingestion; these expose callboard's OWN web server via cloudflared
  // so the user can reach their instance from outside the LAN. Off by default —
  // enabling makes the site globally reachable, so the backend blocks enabling
  // unless a login password is configured. See services/web-tunnel.ts.

  /** Master toggle for the remote-access cloudflared tunnel. Default: false. */
  remoteAccessEnabled?: boolean;

  /**
   * Tunnel flavour. "quick" → ephemeral *.trycloudflare.com URL (no Cloudflare
   * account). "named" → stable hostname via a token-based Cloudflare tunnel.
   * Default: "quick".
   */
  remoteAccessMode?: "quick" | "named";

  /** Cloudflare tunnel token (secret) — required for "named" mode. */
  cloudflaredToken?: string;

  /** Public hostname for "named" mode (display + reference). */
  remoteAccessHostname?: string;

  /**
   * Optional allowlist of IPs / CIDRs permitted to reach callboard through the
   * remote-access tunnel. Empty or absent ⇒ no restriction (anyone with the URL
   * can reach the login page). Loopback and private-LAN ranges are ALWAYS
   * allowed and are never gated by this list. See backend/src/utils/ip-allowlist.ts.
   */
  remoteAccessIpAllowlist?: string[];

  /**
   * May Settings → API offer a button that runs `npm install -g <engine CLI>`
   * on this machine? Absent or `true` ⇒ yes, for loopback and LAN clients only.
   *
   * The capability switch for the one and only place Callboard executes a
   * command on a user's request. Three things narrow it before this flag is even
   * read — the package must be in the closed allowlist in
   * `backend/src/services/engine-install-recipes.ts`, the client must be on the
   * LAN (a request arriving through the remote-access tunnel never qualifies,
   * whatever this is set to), and npm's global prefix must be writable — so this
   * exists for the operator who wants none of it regardless: setting it to
   * `false` removes the button everywhere and leaves the copy-and-paste command
   * that was always the fallback.
   *
   * Default-on rather than default-off because the gate that matters is the
   * client scope, and a locally-reachable Callboard already runs whatever a chat
   * asks it to.
   *
   * ## What this does not defend against, said plainly
   *
   * `PUT /api/agent-settings` is **not** scope-gated — any authenticated client,
   * including one on the remote-access tunnel, can set this back to `true`. That
   * is harmless today only because such a client still fails the
   * `isDirectLocalClient` check and is refused anyway, so flipping the flag buys
   * them nothing. But it does mean this switch governs *the operator's own local
   * browsers*, and is not a second barrier against a remote attacker. The client
   * check is the barrier; this is a policy control layered on top of it. If the
   * scope gate were ever relaxed, this flag would have to be gated at the same
   * time or it would be decorative.
   *
   * Written to only on an explicit boolean — a non-boolean value leaves the
   * stored setting untouched rather than clearing it, because clearing it means
   * reverting to the permissive default. See `routes/agent-settings.ts`.
   *
   * @see plans/engine-availability-and-install.md — Phase 3
   */
  allowEngineInstalls?: boolean;

  /** Default local MCP config directory path (read-only, computed by backend) */
  defaultLocalMcpConfigDir?: string;

  /** Default remote MCP config directory path (read-only, computed by backend) */
  defaultRemoteMcpConfigDir?: string;

  // ── Claude Agent SDK API / auth / model overrides ─────────────────
  // Each field maps to a single environment variable that the Agent SDK
  // consumes. When set, the value is injected into the SDK subprocess env;
  // when empty/undefined, the surrounding process.env takes over (which is
  // usually the subscription-based login flow).

  /** ANTHROPIC_BASE_URL — override the API endpoint (proxy / gateway). */
  apiBaseUrl?: string;

  /** ANTHROPIC_API_KEY — raw API key sent as X-Api-Key. */
  apiKey?: string;

  /** ANTHROPIC_AUTH_TOKEN — Bearer token (mutually exclusive with apiKey in practice). */
  authToken?: string;

  /** ANTHROPIC_MODEL — primary model alias or full ID for the session. */
  model?: string;

  /** ANTHROPIC_DEFAULT_OPUS_MODEL — model the `opus` alias resolves to. */
  defaultOpusModel?: string;

  /** ANTHROPIC_DEFAULT_SONNET_MODEL — model the `sonnet` alias resolves to. */
  defaultSonnetModel?: string;

  /** ANTHROPIC_DEFAULT_HAIKU_MODEL — model the `haiku` alias resolves to. */
  defaultHaikuModel?: string;

  /** CLAUDE_CODE_SUBAGENT_MODEL — model used by spawned subagents. */
  subagentModel?: string;

  /**
   * Absolute path to a `claude` binary to run instead of the one Callboard would
   * find for itself.
   *
   * Highest-priority input to `getClaudeCodeExecutablePath()`, ahead of
   * `which claude` and ahead of the Agent SDK's own bundled per-platform binary.
   * It is checked before it is used — a path that does not exist, is not a file,
   * or carries no execute bit for the user running the daemon is **rejected**,
   * logged, and reported on the Claude Code status card, and resolution falls
   * through as if the field were blank. Silently handing an unspawnable path to
   * the SDK would break every chat; silently ignoring a broken one without
   * saying so would be worse.
   *
   * Note it does **not** feed `utils/paths.ts`'s `getClaudeBinaryPath()`, which
   * is a separate lookup (it reads `$CLAUDE_BINARY` and four well-known
   * directories) behind the About page's CLI version and the login prompt. The
   * two can therefore name different binaries, and the status card says so when
   * they do rather than pretending one answer covers both.
   */
  pathToClaudeCodeExecutable?: string;

  // ── Claude Code → OpenRouter endpoint routing ─────────────────────
  // Run the NATIVE Claude Code harness but point it at OpenRouter's
  // Anthropic-compatible gateway (https://openrouter.ai/api). This is what
  // replaced the standalone OpenRouter harness: the credentials, not the engine.

  /**
   * When true, route the native Claude Code harness through OpenRouter. Hard-codes
   * ANTHROPIC_BASE_URL to OpenRouter's gateway, sends claudeCodeOpenRouterApiKey as
   * ANTHROPIC_AUTH_TOKEN, and forces ANTHROPIC_API_KEY empty. Overrides the manual
   * apiBaseUrl/apiKey/authToken fields above. Model fields then hold OpenRouter slugs.
   */
  claudeCodeUseOpenRouter?: boolean;

  /** Dedicated OpenRouter API key for Claude-Code-via-OpenRouter (→ ANTHROPIC_AUTH_TOKEN). */
  claudeCodeOpenRouterApiKey?: string;

  /**
   * Override the OpenRouter Anthropic-gateway endpoint used when
   * {@link claudeCodeUseOpenRouter} is on (→ ANTHROPIC_BASE_URL). Set, it always
   * wins — including when the routing credentials come from the ambient
   * environment rather than {@link claudeCodeOpenRouterApiKey}. Blank/unset ⇒ the
   * default `https://openrouter.ai/api` with a stored key, or whatever endpoint
   * the environment already chose when the key is the environment's. Exists so users can point the native
   * Claude Code harness at OpenRouter's regional endpoints (US/EU) or any future
   * variant without a code change. Must include the Anthropic-compatible `/api`
   * path (NO `/v1` suffix) — this is a full base URL, not just a host.
   */
  claudeCodeOpenRouterBaseUrl?: string;

  // ── Claude Code → OpenRouter model overrides ──────────────────────
  // Parallel to the five generic model fields above, but only consulted while
  // {@link claudeCodeUseOpenRouter} is on. The two sets are deliberately
  // SEPARATE: a native session wants Anthropic aliases/ids ("opus",
  // "claude-opus-4-7") while a routed session wants OpenRouter slugs
  // ("anthropic/claude-opus-4.8"), and a single shared field meant flipping the
  // toggle left the other mode pointing at a model its endpoint can't resolve.
  // Each mode now keeps its own values, so toggling is lossless in both
  // directions. Blank fields still fall back to the live-catalog role defaults
  // (see getApiEnvOverrides), so leaving all five empty remains the easy path.

  /** ANTHROPIC_MODEL while routing through OpenRouter. */
  claudeCodeOpenRouterModel?: string;

  /** ANTHROPIC_DEFAULT_OPUS_MODEL while routing through OpenRouter. */
  claudeCodeOpenRouterOpusModel?: string;

  /** ANTHROPIC_DEFAULT_SONNET_MODEL while routing through OpenRouter. */
  claudeCodeOpenRouterSonnetModel?: string;

  /** ANTHROPIC_DEFAULT_HAIKU_MODEL while routing through OpenRouter. */
  claudeCodeOpenRouterHaikuModel?: string;

  /** CLAUDE_CODE_SUBAGENT_MODEL while routing through OpenRouter. */
  claudeCodeOpenRouterSubagentModel?: string;

  // ── OpenRouter (a service, not a harness) ─────────────────────────
  // OpenRouter stopped being a selectable agent harness; the credential below
  // stayed, because two things that are not the harness still need it: the
  // utility completions (chat titles, branch names, themes) and the
  // account-wide fallback key for ACP agents. Settings → API's OpenRouter tab
  // is therefore a credential page, not a provider page.

  /**
   * OPENROUTER_API_KEY — the account-wide OpenRouter credential.
   *
   * Two consumers, both outside any harness:
   *  - utility completions, when {@link openRouterUtilityCompletions} is on
   *    (see services/openrouter-completion.ts);
   *  - ACP agents, as the fallback when {@link acpOpenRouterApiKey} is blank
   *    (see services/claude.ts).
   *
   * Note this is NOT the key used to route a native harness through OpenRouter
   * — those modes each carry their own (`claudeCodeOpenRouterApiKey`,
   * `codexOpenRouterApiKey`), so a user can scope keys per use.
   */
  openRouterApiKey?: string;

  /**
   * OPENROUTER_BASE_URL — override the OpenRouter API endpoint this key talks
   * to (proxy, regional mirror). Read by the model catalog and the utility
   * completion client through one shared resolver, so the two cannot disagree
   * about where the key belongs. Blank ⇒ `https://openrouter.ai/api/v1`.
   */
  openRouterBaseUrl?: string;

  /**
   * Use OpenRouter for utility completions — the one-shot calls that generate
   * chat titles, git branch names and themes. Off (or absent) ⇒ they run on the
   * Claude Code SDK, which needs no extra configuration.
   *
   * Explicit opt-in on purpose. The old behavior was "an OpenRouter key exists,
   * so use it", which silently moved every title/branch/theme call onto a
   * metered account the moment a key was saved for something else entirely.
   * Existing key-holders are migrated to `true` on load exactly once, so the
   * upgrade changes nobody's behavior — see migrateOpenRouterUtilityCompletions.
   */
  openRouterUtilityCompletions?: boolean;

  // ── OpenRouter utility completion models ──────────────────────────
  // One slug per tier the utility callers ask for: titles and branch names run
  // on haiku, theme generation on sonnet. Blank ⇒ `~anthropic/claude-<tier>-
  // latest`, OpenRouter's own server-resolved aliases, so the cheap tier stays
  // cheap without anyone maintaining a version number here. Naming matches the
  // `claudeCodeOpenRouter*Model` convention above.

  /** Model for haiku-tier utility completions (chat titles, branch names). */
  openRouterUtilityHaikuModel?: string;

  /** Model for sonnet-tier utility completions (theme generation). */
  openRouterUtilitySonnetModel?: string;

  /** Model for opus-tier utility completions. No caller asks for this tier today. */
  openRouterUtilityOpusModel?: string;

  /**
   * @deprecated Superseded by the cross-harness {@link modelAliases} registry.
   * Retained for backward compatibility: on load, each `{name → slug}` entry is
   * folded into the `openrouter` target of a matching {@link ModelAlias} (see
   * migrateModelAliases). Still accepted on write and merged in, but new code
   * should read/write `modelAliases`.
   *
   * User-defined model aliases — maps a custom name (e.g. "low coder") to a
   * real OpenRouter model slug (e.g. "deepseek/deepseek-chat").
   */
  openRouterModelAliases?: Record<string, string>;

  /**
   * Cross-harness model aliases. One named alias resolves to a different
   * concrete model per provider — an Anthropic alias/ID for claude-code, an OR
   * slug for openrouter, a Codex slug for codex — so `model: "planner"` works on
   * any harness. Accepted anywhere a model is configured (new chats, per-chat
   * overrides, provider defaults, cron/trigger actions, job steps, MCP tools)
   * and resolved to the per-provider target when the session starts. Lookup is
   * case-insensitive; an alias shadows a real model id of the same name. Targets
   * must be real model ids, never other aliases (one-hop, cycle-free). See
   * {@link ModelAlias} and resolveModelAlias.
   */
  modelAliases?: ModelAlias[];

  // ── Codex (alternative provider, subscription-auth) ───────────────
  // Populated when the user enables the OpenAI Codex provider in
  // Settings → API. Codex wraps the `codex` Rust CLI via @openai/codex-sdk
  // and authenticates either against a ChatGPT subscription (the primary
  // path on a personal machine — credentials live in $CODEX_HOME/auth.json,
  // written by `codex login --device-auth`) or a raw OpenAI API key.

  /**
   * Codex auth mode. "subscription" (default) uses ChatGPT-login credentials
   * stored in $CODEX_HOME/auth.json — no key needed. "api-key" uses
   * codexApiKey / codexBaseUrl instead.
   */
  codexAuthMode?: "subscription" | "api-key";

  /** OPENAI_API_KEY — only used when codexAuthMode === "api-key". */
  codexApiKey?: string;

  /** OPENAI_BASE_URL — override the OpenAI API endpoint, api-key mode only. */
  codexBaseUrl?: string;

  /** Default Codex model for new chats, e.g. "gpt-5.5". */
  codexModel?: string;

  /**
   * CODEX_HOME — directory where the Codex CLI stores auth.json and the
   * sessions/ rollout tree. Defaults to ~/.codex when unset. Always injected
   * into the SDK subprocess env so callboard controls the auth/session location.
   */
  codexHome?: string;

  /**
   * Absolute path to a `codex` binary to run instead of the one bundled with
   * `@openai/codex-sdk` (→ the SDK's `CodexOptions.codexPathOverride`).
   *
   * The SDK has always accepted this; Callboard never passed it, so every chat
   * ran the platform binary nested inside Callboard's own `node_modules`. That
   * copy is fine — it just never reaches the user's `PATH`, which is why
   * Settings → API offers `npm i -g @openai/codex` so `codex login` exists as a
   * command. With this field set, that same global install also becomes the
   * binary chats run, and the status card says which of the two is in effect.
   *
   * Checked before use, exactly like {@link pathToClaudeCodeExecutable}: a
   * missing, non-file or non-executable path is rejected, logged, reported on
   * the card, and chats fall back to the bundled binary. Unlike the Claude Code
   * field there is **no PATH lookup** behind it — an override or the bundled
   * copy, nothing else. Probing `PATH` here would silently change which binary
   * ran for everyone who followed the login recipe, which that recipe explicitly
   * promises it will not do.
   *
   * Only the executable path moves. `CODEX_HOME`, auth and config still come
   * from {@link codexHome} and the rest of this block, so an overridden binary
   * reads the same credentials the bundled one did.
   */
  codexPathOverride?: string;

  /** Codex sandbox mode, mapped onto the CLI's `--sandbox` flag. */
  codexSandboxMode?: "read-only" | "workspace-write" | "danger-full-access";

  // ── Codex → OpenRouter endpoint routing ───────────────────────────
  // Run the NATIVE Codex harness against OpenRouter via a custom config.toml
  // model provider (wire_api="responses"). Takes precedence over codexAuthMode.

  /**
   * When true, route the native Codex harness through OpenRouter. Injects a
   * `[model_providers.openrouter]` block (base_url https://openrouter.ai/api/v1,
   * wire_api "responses") into the Codex config and exposes codexOpenRouterApiKey
   * as OPENROUTER_API_KEY. Overrides codexBaseUrl/codexApiKey. codexModel then
   * holds an OpenRouter slug. Non-OpenAI models may not support the Responses wire API.
   */
  codexUseOpenRouter?: boolean;

  /** Dedicated OpenRouter API key for Codex-via-OpenRouter (→ OPENROUTER_API_KEY). */
  codexOpenRouterApiKey?: string;

  /**
   * Override the OpenRouter endpoint used when {@link codexUseOpenRouter} is on
   * (→ the injected `[model_providers.openrouter]` block's `base_url`).
   * Blank/unset ⇒ the default `https://openrouter.ai/api/v1`, or — when the
   * routing is credentialed by an ambient OpenRouter setup rather than
   * {@link codexOpenRouterApiKey} — that setup's own endpoint, left untouched.
   * Lets users target OpenRouter's regional endpoints (US/EU) without a code change. Must include
   * the OpenAI-compatible `/api/v1` path — note this differs from
   * {@link claudeCodeOpenRouterBaseUrl}, which takes the bare `/api` Anthropic
   * gateway path.
   */
  codexOpenRouterBaseUrl?: string;

  /**
   * When true, hand ACP agents an OpenRouter credential so they can route
   * through it.
   *
   * Unlike the Claude Code and Codex toggles, this injects nothing into the
   * agent's configuration and rewrites no endpoint. An ACP agent is a
   * third-party CLI that already knows how to talk to OpenRouter; all callboard
   * supplies is the key, through the environment variable the vendor's preset
   * declares (`AcpVendorPreset.openRouterApiKeyEnv`). A vendor that declares
   * none never receives a key, which is the guard that keeps this from spraying
   * a credential at an arbitrary binary.
   *
   * The agent decides what to do with it. OpenCode, given
   * `OPENROUTER_API_KEY`, adds ~340 `openrouter/*` entries to the model list it
   * advertises — so selecting one is the ordinary per-chat model choice, not a
   * separate mode.
   *
   * One flag covers every ACP vendor, the same trade the alias registry makes:
   * exactly one ships today, and the per-vendor `openRouterApiKeyEnv` gate means
   * an unrelated vendor is skipped rather than handed the key.
   */
  acpUseOpenRouter?: boolean;

  /**
   * Dedicated OpenRouter API key for ACP agents.
   *
   * Blank falls back to {@link openRouterApiKey}, the account-wide key — which
   * is what most users want and what the Codex pair deliberately does NOT do
   * (its separate key exists because its routing rewrites Codex's own provider
   * config, and mixing the two was lossy). Nothing is rewritten here, so there
   * is no reason to make a user re-enter a key they have already given.
   */
  acpOpenRouterApiKey?: string;

  /**
   * Default model for new Codex chats while {@link codexUseOpenRouter} is on.
   * Separate from {@link codexModel} for the same reason the Claude Code pair is
   * split: native Codex wants a bare CLI slug ("gpt-5.5") and the routed harness
   * wants an OpenRouter slug ("openai/gpt-5.5-codex"), so sharing one field made
   * toggling lossy. Blank ⇒ the harness's own default.
   */
  codexOpenRouterModel?: string;

  // ── Cline ──────────────────────────────────────────────────────────
  // Settings → API. Cline embeds the `@cline/sdk` agent runtime **in the backend
  // process** — there is no binary to configure and no login to perform, so
  // unlike the Codex block below there is no auth *mode*: credentials are config
  // fields handed to the runtime per session.

  /**
   * Which Cline provider backs new Cline chats — `"anthropic"`, `"openai"`,
   * `"google"`, `"bedrock"`, `"mistral"`, `"openai-compatible"`, …
   *
   * Blank defaults to `"anthropic"`. The full list the installed SDK supports is
   * served by `GET /api/cline/models`, which reads it from the SDK rather than
   * from a table here — a hardcoded list would drift on every bump.
   */
  clineProviderId?: string;

  /** Default model id for new Cline chats. Blank ⇒ the provider's own default. */
  clineModel?: string;

  /**
   * API key for {@link clineProviderId}.
   *
   * Blank means the runtime falls back to its own environment lookup
   * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, the AWS credential chain, …), which
   * is the right behaviour for a machine that already has those configured.
   */
  clineApiKey?: string;

  /**
   * Base URL override, for an OpenAI-compatible or self-hosted endpoint.
   *
   * Note there is deliberately no `clineUseOpenRouter` toggle to match the Codex
   * and ACP ones. Those exist because routing those harnesses through OpenRouter
   * means rewriting a config file or injecting an environment variable. Cline
   * ships `openrouter` as a **first-class provider id** — verified against the
   * installed SDK, which advertises 270 models under it — so for Cline
   * OpenRouter is not a mode, it is simply a value of {@link clineProviderId}
   * with its key in {@link clineApiKey}. No base URL needed.
   */
  clineBaseUrl?: string;

  /**
   * Ceiling on agent-loop iterations per turn. Blank ⇒ the SDK's own default.
   *
   * Surfaces as `AgentEvent.result.status = "max_turns"` when hit, the same as
   * Claude Code's `maxTurns`.
   */
  clineMaxIterations?: number;

  // ── pi ─────────────────────────────────────────────────────────────
  // Settings → API. Like Cline, pi embeds its agent runtime **in the backend
  // process**, so there is no binary to configure and no login: credentials are
  // config fields handed to the runtime per session and never written to the
  // user's own `~/.pi/agent/auth.json`.

  /**
   * Which pi provider backs new pi chats — `"openrouter"`, `"anthropic"`,
   * `"google"`, `"openai"`, …
   *
   * Blank defaults to `"openrouter"`: pi is the agent underneath OpenRouter's
   * Ori, and its bundled catalog carries 307 OpenRouter models offline. The full
   * list is served by `GET /api/pi/providers`, read from the installed package
   * rather than from a table here — a hardcoded list would drift on every bump.
   */
  piProviderId?: string;

  /** Default model id for new pi chats. Blank ⇒ pi's own default. */
  piModel?: string;

  /**
   * API key for {@link piProviderId}.
   *
   * Injected into the session's `ModelRuntime` at run time, never persisted to
   * pi's auth file. Blank means pi falls back to its own environment lookup
   * (`OPENROUTER_API_KEY`, …) — and note the explicit key **wins** over the
   * environment when both are present, so a shell variable cannot silently take
   * over a chat configured with a different key.
   */
  piApiKey?: string;

  /**
   * Base URL override, for an OpenAI-compatible or self-hosted endpoint.
   *
   * As with Cline there is deliberately no `piUseOpenRouter` toggle: OpenRouter
   * is a first-class value of {@link piProviderId}, not a mode.
   */
  piBaseUrl?: string;

  // No `piThinkingLevel` here, despite the plan listing one. Reasoning effort is
  // per-chat for every harness — it rides on `ProviderRunConfig.effort` and is
  // persisted to chat metadata by `routes/stream.ts` — and no other provider
  // keeps a settings-level default. Adding one only for pi would ship a field
  // nothing reads.

  // ── Session completion callbacks ("phone home") loop-safety ───────
  // Bounds on the onComplete feature (start_chat_session, continue_chat), which
  // automatically re-invokes a parent chat when the session it is waiting on
  // finishes.

  /**
   * Max callback-chain depth. A re-invoked parent that spawns another
   * onComplete child increments depth; once a new child would exceed this, it
   * still runs but does not register a callback. Guards against runaway
   * parent↔child recursion. Default: 10.
   */
  maxCallbackChainDepth?: number;

  /**
   * Max number of outstanding (undelivered) completion callbacks across the
   * whole instance. New onComplete registrations beyond this are skipped (the
   * session still starts / the message is still sent). Caps fan-out breadth.
   * Default: 25.
   */
  maxPendingCallbacks?: number;
}

export interface KeyAliasInfo {
  /** Directory name under keys/callers/ */
  alias: string;
  /** Whether signing.pub.pem exists in the alias directory */
  hasSigningPub: boolean;
  /** Whether exchange.pub.pem exists in the alias directory */
  hasExchangePub: boolean;
}

/** An agent bound to an enrolled caller (the minimal identity the UI shows). */
export interface EnrolledCallerAgent {
  alias: string;
  name: string;
  emoji?: string;
}

/**
 * An enrolled drawlatch caller credential stored on this callboard, enriched
 * with the agents that use it and the fingerprint that identifies the keypair.
 * Surfaced in the Proxy Settings "Enrolled callers" management panel.
 */
export interface EnrolledCaller {
  /** Caller alias (directory name under keys/callers/). */
  alias: string;
  /** Proxy mode whose key store this caller lives in. */
  mode: "local" | "remote";
  /**
   * Fingerprint of the caller keypair, recomputed from the stored public keys.
   * Identifies which credential an alias holds (e.g. to tell stale callers from
   * different callboards apart). Null if the public keys can't be read/parsed.
   */
  fingerprint: string | null;
  /** Agents currently bound to this caller in this mode. */
  agents: EnrolledCallerAgent[];
  /** False when one or more agents reference it — deletion is blocked. */
  canDelete: boolean;
  /**
   * True when this caller is the default for regular (non-agent) sessions in
   * this mode. At most one caller per mode is the default; when none is, regular
   * sessions have no drawlatch/MCP-proxy access.
   */
  isDefault: boolean;
}
