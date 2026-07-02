import type { OpenRouterServerToolConfig, OpenRouterParamProfile } from "./openrouterCatalog.js";

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

  /** Path to the Claude Code executable. Overrides the SDK's bundled binary. */
  pathToClaudeCodeExecutable?: string;

  // ── Claude Code → OpenRouter endpoint routing ─────────────────────
  // Run the NATIVE Claude Code harness but point it at OpenRouter's
  // Anthropic-compatible gateway (https://openrouter.ai/api). Distinct from
  // the standalone OpenRouter provider below, which runs its own harness.

  /**
   * When true, route the native Claude Code harness through OpenRouter. Hard-codes
   * ANTHROPIC_BASE_URL to OpenRouter's gateway, sends claudeCodeOpenRouterApiKey as
   * ANTHROPIC_AUTH_TOKEN, and forces ANTHROPIC_API_KEY empty. Overrides the manual
   * apiBaseUrl/apiKey/authToken fields above. Model fields then hold OpenRouter slugs.
   */
  claudeCodeUseOpenRouter?: boolean;

  /** Dedicated OpenRouter API key for Claude-Code-via-OpenRouter (→ ANTHROPIC_AUTH_TOKEN). */
  claudeCodeOpenRouterApiKey?: string;

  // ── OpenRouter (alternative provider) ─────────────────────────────
  // Populated when the user enables the OpenRouter provider in
  // Settings → API. Empty values mean "OpenRouter unavailable" — the
  // New Chat panel's provider toggle (PR D) is disabled in that state.

  /** OPENROUTER_API_KEY — required to enable the OpenRouter provider. */
  openRouterApiKey?: string;

  /** OPENROUTER_BASE_URL — override the OR API endpoint. */
  openRouterBaseUrl?: string;

  /** Default model alias for new OR chats. Defaults to `~anthropic/claude-sonnet-latest`. */
  openRouterModel?: string;

  /** Absolute path to write OR session logs into. Defaults to `~/.openrouter-agent-harness/logs`. */
  openRouterLogsRoot?: string;

  /**
   * Per-session OpenRouter spend cap in USD. When omitted, the OR library's
   * own default (currently $1.00) applies — which historically surprised
   * users with an unexplained "Agent reached the maximum budget limit." after
   * a couple dozen turns. Surfacing this knob lets users opt into a higher
   * ceiling for long-running coding sessions.
   */
  openRouterMaxBudgetUsd?: number;

  /**
   * User-defined model aliases — maps a custom name (e.g. "low coder") to a
   * real OpenRouter model slug (e.g. "deepseek/deepseek-chat"). Aliases are
   * accepted anywhere an OpenRouter model is configured (new chats, per-chat
   * overrides, the global default above, cron/trigger actions, MCP tools)
   * and resolve to the target slug when the session starts. Lookup is
   * case-insensitive; an alias shadows a real model slug of the same name.
   * Targets must be real slugs, never other aliases (keeps resolution one
   * hop and cycle-free).
   */
  openRouterModelAliases?: Record<string, string>;

  /**
   * OpenRouter server tools (executed on OR's servers) to enable, with their
   * params. `undefined` ⇒ inherit the harness's three defaults
   * (datetime/web_search/web_fetch); an explicit empty array ⇒ all server
   * tools disabled. Each entry is validated against the `OR_SERVER_TOOLS`
   * catalog. See {@link OpenRouterServerToolConfig}.
   */
  openRouterServerTools?: OpenRouterServerToolConfig[];

  /**
   * Global default OpenRouter generation parameters + plugins, applied to
   * every OR chat. Merged with any matching per-model profile (per-model
   * wins). camelCase keys validated against `OR_SAMPLING_PARAMS`/`OR_PLUGINS`.
   */
  openRouterModelParamsDefault?: OpenRouterParamProfile;

  /**
   * Per-model OpenRouter parameter overrides, keyed by the RESOLVED model slug
   * (after alias expansion), e.g. "openrouter/pareto-code". Lets model-specific
   * plugin params (pareto-router's minCodingScore, fusion's analysisModels)
   * attach only to the model they affect. Merged over
   * {@link openRouterModelParamsDefault} at run time.
   */
  openRouterModelParamProfiles?: Record<string, OpenRouterParamProfile>;

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

  // ── Session completion callbacks ("phone home") loop-safety ───────
  // Bounds on the start_chat_session onComplete feature, which automatically
  // re-invokes a parent chat when a spawned child session finishes.

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
   * session still starts). Caps fan-out breadth. Default: 25.
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
