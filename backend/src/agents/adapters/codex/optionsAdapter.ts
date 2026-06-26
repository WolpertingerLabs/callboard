/**
 * Options translation: Claude-SDK-shaped {@link AgentQueryRequest.options} →
 * Codex `@openai/codex-sdk` construction inputs ({@link CodexOptions} +
 * {@link ThreadOptions} + the resume thread id).
 *
 * `claude.ts:sendMessage` builds one loose `Record<string, unknown>` every
 * provider consumes. The Codex adapter reads the same shape — the fields with a
 * Codex equivalent map across (`cwd` → `workingDirectory` + `skipGitRepoCheck`,
 * `systemPrompt` → a temp `model_instructions_file`, `model`, `resume` →
 * `resumeThread`), DefaultPermissions collapse onto `sandboxMode` +
 * `approvalPolicy` (see {@link mapPermissionsToCodex}), and Codex-specific
 * settings ride in via the `codex` sub-object ({@link CodexOptionsExtras}) that
 * claude.ts populates for Codex chats (auth mode, api key/base url, model,
 * explicit sandbox override, permissions).
 *
 * **Subscription vs api-key construction.** Default (subscription) mode passes
 * **no `apiKey`** so the Codex CLI falls back to `$CODEX_HOME/auth.json` (the
 * stored ChatGPT login). api-key mode passes the key via `CodexOptions.apiKey`
 * (the SDK turns it into `CODEX_API_KEY`, not `OPENAI_API_KEY` — spike §2.2) and
 * the optional base url via `CodexOptions.baseUrl`. Either way the full process
 * environment (carrying `CODEX_HOME`, injected by `getApiEnvOverrides`) is
 * forwarded as a COMPLETE env so the CLI locates `auth.json`/`sessions/` — see
 * {@link buildCodexEnv} for why a complete env is required, not a partial one.
 *
 * The `prompt` is NOT read here — the port carries it on `AgentQueryRequest` and
 * {@link CodexAgentQuery} drains it lazily. `sessionId` likewise: a `resume`
 * value selects `resumeThread`, its absence a fresh `startThread`.
 *
 * @see plans/codex-adapter-job.md (Step 5 options-perms)
 * @see plans/codex-spike-findings.md (§2 option→flag mapping, §2.3 env)
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalMode, CodexOptions, ModelReasoningEffort, SandboxMode, ThreadOptions } from "@openai/codex-sdk";
import type { DefaultPermissions, EffortLevel } from "shared/types/index.js";
import {
  defaultApprovalForSandbox,
  hasAnyAsk,
  mapPermissionsToCodex,
} from "./permissionAdapter.js";
import {
  isCodexToolServerHandle,
  type CodexMcpServerConfig,
  type CodexToolServerHandle,
} from "./toolAdapter.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("codex-adapter");

/**
 * Sub-object on the options Record carrying Codex-specific configuration. Set
 * by claude.ts when routing a call to the Codex adapter (the wiring that
 * populates it lands in the wire-e2e slice — read defensively here). Mirrors the
 * `openRouter` extras pattern.
 */
export interface CodexOptionsExtras {
  /** Subscription (ChatGPT login) vs raw API key. Default subscription — no key passed. */
  authMode?: "subscription" | "api-key";
  /** OPENAI/Codex API key — only consumed in api-key mode (→ CodexOptions.apiKey → CODEX_API_KEY). */
  apiKey?: string;
  /** Base URL override — api-key mode only (→ CodexOptions.baseUrl → --config openai_base_url). */
  baseUrl?: string;
  /**
   * Route the native Codex harness through OpenRouter. When true, a custom
   * `[model_providers.openrouter]` block (base_url https://openrouter.ai/api/v1,
   * wire_api "responses") is injected into the Codex config and `model_provider`
   * is set to "openrouter". Takes precedence over {@link authMode}; the key rides
   * in via OPENROUTER_API_KEY (the block's env_key), set by getApiEnvOverrides.
   */
  useOpenRouter?: boolean;
  /** Default model, e.g. "gpt-5.5". Overrides a top-level `options.model`. */
  model?: string;
  /**
   * Explicit Codex sandbox tier from the `codexSandboxMode` setting. When set it
   * OVERRIDES the permission-derived sandbox ({@link resolveSandboxAndApproval}) —
   * a user who picks a tier in Settings gets exactly that tier; approval policy
   * still honors any "ask" in {@link permissions}.
   */
  sandboxMode?: SandboxMode;
  /**
   * callboard's default permissions for this chat. Mapped onto Codex's
   * `sandboxMode` + `approvalPolicy` (Codex has no per-call `canUseTool` hook —
   * permissions are decided once at thread start). Omitted ⇒ leave both unset so
   * the Codex CLI applies its own defaults.
   */
  permissions?: DefaultPermissions;
  /**
   * Per-chat reasoning effort, surfaced in the UI the same way OpenRouter's is
   * (the shared `effort` chat-metadata field). Maps onto Codex's
   * `modelReasoningEffort` ThreadOption (how hard gpt-5.x thinks). The shared
   * {@link EffortLevel} has one extra level Codex lacks — `"none"` — which we
   * read as "suppress reasoning summaries" (`model_reasoning_summary: "none"`)
   * rather than a Codex effort tier. Omitted ⇒ Codex's own default effort with
   * summaries on ("auto").
   */
  reasoningEffort?: EffortLevel;
}

/**
 * Loose typing of the Claude-SDK-shaped options blob — narrows the fields the
 * Codex adapter actually reads. Unknown keys are tolerated and ignored.
 */
interface ClaudeShapedOptions {
  cwd?: string;
  resume?: string;
  model?: string;
  systemPrompt?: string | { type: "preset"; preset?: string; append?: string };
  /**
   * Subprocess environment claude.ts assembles as `{ ...process.env,
   * ...getApiEnvOverrides() }` — carries `CODEX_HOME` (and, in api-key mode,
   * `OPENAI_*`). Forwarded VERBATIM (sans undefined values) to
   * `CodexOptions.env` so the CLI reads the configured auth/session home. See
   * {@link buildCodexEnv}.
   */
  env?: Record<string, string | undefined>;
  /**
   * Tool servers built by `CodexAdapter.buildToolServer` (one per callboard tool
   * bundle), keyed by server name. claude.ts populates this the same way it does
   * for the other providers — with each provider's opaque server object. For
   * Codex those objects are {@link CodexToolServerHandle}s; {@link collectCodexMcpServers}
   * turns them into `config.mcp_servers` entries and threads the handles out for
   * lifecycle cleanup. Foreign-shaped entries are ignored defensively.
   */
  mcpServers?: Record<string, unknown>;
  codex?: CodexOptionsExtras;
}

/** What {@link translateCodexOptions} hands the adapter to construct a run. */
export interface CodexTranslatedOptions {
  /** Passed to `new Codex(...)`. No `apiKey` in subscription mode. */
  codexOpts: CodexOptions;
  /** Passed to `startThread`/`resumeThread`. */
  threadOptions: ThreadOptions;
  /** Resume an existing thread when set; `null` ⇒ start a fresh thread. */
  resumeId: string | null;
  /**
   * Absolute path of a temp file holding the resolved system prompt, referenced
   * by `codexOpts.config.model_instructions_file`. The Codex CLI reads it when
   * the subprocess spawns, so it must outlive query() — {@link CodexAgentQuery}
   * deletes it (and its temp dir) once the run finishes or is aborted. `null`
   * when there is no system prompt.
   */
  instructionsFilePath: string | null;
  /** Resolved auth mode (for logging). */
  authMode: "subscription" | "api-key";
  /** Resolved model (for logging); undefined ⇒ CLI default. */
  model?: string;
  /**
   * Live tool-server handles backing the `config.mcp_servers` entries. The
   * adapter hands these to {@link CodexAgentQuery}, which closes them (stops the
   * listening sockets, removes temp dirs) once the turn ends. Empty when the run
   * has no callboard tools.
   */
  toolServerHandles: CodexToolServerHandle[];
}

/**
 * Translate one user-configured EXTERNAL MCP server entry (the Claude-SDK shape
 * `claude.ts` assembles from `getEnabledMcpServers()`) into a Codex
 * `mcp_servers` config entry, or `null` when the shape is unrecognized.
 *
 * Codex is itself an MCP client, so unlike callboard's own in-process tool
 * bundles (which must be relayed through the shim to keep live backend state)
 * these external servers are separate processes/endpoints Codex can connect to
 * directly. Two transports map across:
 *   - **stdio** (`{ command, args, env }`) → Codex stdio entry (same fields).
 *   - **streamable HTTP / SSE** (`{ type, url, headers }`) → Codex `{ url }`.
 *     Codex forwards only a bearer token (via env var), not arbitrary headers,
 *     so custom `headers` are dropped with a warning rather than silently lost.
 */
export function externalToCodexMcpConfig(
  name: string,
  value: Record<string, unknown>,
): CodexMcpServerConfig | null {
  if (typeof value.command === "string") {
    const cfg: CodexMcpServerConfig = {
      command: value.command,
      args: Array.isArray(value.args) ? value.args.map((a) => String(a)) : [],
    };
    const env = sanitizeEnvRecord(value.env);
    if (env) cfg.env = env;
    return cfg;
  }
  if (typeof value.url === "string") {
    if (value.headers && typeof value.headers === "object" && Object.keys(value.headers).length > 0) {
      log.warn(
        `translateCodexOptions — external HTTP MCP server "${name}" declares custom headers Codex can't forward ` +
          `(it supports only a bearer-token env var); bridging the URL without them`,
      );
    }
    return { url: value.url };
  }
  return null;
}

/** Coerce a loosely-typed env bag to `Record<string,string>`, dropping non-string values. */
function sanitizeEnvRecord(env: unknown): Record<string, string> | undefined {
  if (!env || typeof env !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Split the loosely-typed `options.mcpServers` record into the Codex
 * `mcp_servers` config map and the live handles to clean up.
 *
 * Two kinds of entry contribute:
 *   - {@link CodexToolServerHandle}s — callboard's own tool bundles, hosted
 *     in-process and reached via the relay shim (their handles ride out for
 *     lifecycle cleanup).
 *   - external MCP server configs (user-configured stdio/HTTP servers) — Codex
 *     connects to these directly ({@link externalToCodexMcpConfig}); no handle,
 *     since callboard doesn't own their lifecycle.
 * Anything that matches neither shape is logged and skipped.
 */
export function collectCodexMcpServers(mcpServers: ClaudeShapedOptions["mcpServers"]): {
  config?: Record<string, CodexMcpServerConfig>;
  handles: CodexToolServerHandle[];
} {
  if (!mcpServers) return { handles: [] };
  const config: Record<string, CodexMcpServerConfig> = {};
  const handles: CodexToolServerHandle[] = [];
  for (const [name, value] of Object.entries(mcpServers)) {
    if (isCodexToolServerHandle(value)) {
      config[name] = value.toMcpServerConfig();
      handles.push(value);
      continue;
    }
    if (value && typeof value === "object") {
      const ext = externalToCodexMcpConfig(name, value as Record<string, unknown>);
      if (ext) {
        config[name] = ext;
        log.debug(`translateCodexOptions — bridging external MCP server "${name}" (${ext.url ? "http" : "stdio"})`);
        continue;
      }
    }
    log.warn(`translateCodexOptions — ignoring unrecognized mcp server entry "${name}"`);
  }
  return { ...(Object.keys(config).length > 0 ? { config } : {}), handles };
}

/**
 * Resolve Claude's `systemPrompt` (string OR `{ type: "preset", append }`) into
 * the instruction text Codex should run with, or `undefined` when there is
 * nothing to write.
 *
 * A plain string is used verbatim. A preset object loses the named preset's
 * implicit content (Codex has no Claude preset prompts) — only the `append`
 * carries over; an append-less preset yields no file.
 */
export function resolveCodexInstructions(
  systemPrompt: ClaudeShapedOptions["systemPrompt"],
): string | undefined {
  if (typeof systemPrompt === "string") return systemPrompt.length > 0 ? systemPrompt : undefined;
  if (systemPrompt && typeof systemPrompt === "object") {
    const append = systemPrompt.append ?? "";
    return append.length > 0 ? append : undefined;
  }
  return undefined;
}

/**
 * Write the resolved system prompt to a fresh temp file and return its absolute
 * path (for `model_instructions_file`). Uses `mkdtempSync` so concurrent runs
 * never collide; the caller-side cleanup removes the whole temp dir. Synchronous
 * so it stays on the synchronous `query()` path.
 */
export function writeInstructionsFile(instructions: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-instr-"));
  const file = join(dir, "model_instructions.md");
  writeFileSync(file, instructions, "utf-8");
  return file;
}

/**
 * Build a COMPLETE subprocess environment for `CodexOptions.env`, dropping
 * undefined-valued keys.
 *
 * The SDK's exec layer (`@openai/codex-sdk` dist/index.js) treats a provided
 * `env` as a REPLACEMENT for `process.env`, not a merge — if we passed only the
 * overrides the child would lose `PATH`/`HOME`/etc. (spike §2.3). claude.ts
 * already assembles the right thing (`{ ...process.env, ...getApiEnvOverrides()
 * }`, carrying `CODEX_HOME`), so we forward it whole. Returns `undefined` when
 * no env was supplied, letting the SDK fall back to inheriting `process.env`.
 */
export function buildCodexEnv(
  optionsEnv: ClaudeShapedOptions["env"],
): Record<string, string> | undefined {
  if (!optionsEnv) return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(optionsEnv)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Resolve the Codex `sandboxMode` + `approvalPolicy` from the extras:
 *  - explicit `sandboxMode` setting wins over the permission-derived tier, but an
 *    "ask" anywhere in `permissions` still forces `approvalPolicy: on-request`;
 *  - `permissions` alone → {@link mapPermissionsToCodex};
 *  - neither → both left unset so the CLI applies its own defaults.
 */
export function resolveSandboxAndApproval(extras: CodexOptionsExtras): {
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalMode;
} {
  const { permissions, sandboxMode: explicit } = extras;
  if (!permissions && !explicit) return {};

  if (permissions) {
    const mapped = mapPermissionsToCodex(permissions);
    if (!explicit) return mapped;
    // Explicit tier overrides the sandbox; approval follows the explicit tier
    // unless an "ask" pins it to on-request.
    const approvalPolicy = hasAnyAsk(permissions)
      ? "on-request"
      : defaultApprovalForSandbox(explicit);
    return { sandboxMode: explicit, approvalPolicy };
  }

  // Explicit tier with no permission context: pair it with the tier's default
  // approval policy. (`explicit` is necessarily set here — the no-perms/no-tier
  // case returned above — but narrow it for the type checker.)
  if (explicit) {
    return { sandboxMode: explicit, approvalPolicy: defaultApprovalForSandbox(explicit) };
  }
  return {};
}

/**
 * Translate a Claude-SDK-shaped options Record into the inputs
 * {@link CodexAdapter} hands the SDK to start/resume a thread.
 */
export function translateCodexOptions(options: Record<string, unknown>): CodexTranslatedOptions {
  const opts = options as ClaudeShapedOptions;
  const extras = opts.codex ?? {};
  const authMode = extras.authMode ?? "subscription";

  const cwd = typeof opts.cwd === "string" ? opts.cwd : undefined;
  const resumeId = typeof opts.resume === "string" && opts.resume.length > 0 ? opts.resume : null;
  const model = extras.model ?? (typeof opts.model === "string" ? opts.model : undefined);

  // ── Codex client options (auth) ──────────────────────────────────
  // Subscription mode: no apiKey ⇒ the CLI uses $CODEX_HOME/auth.json.
  // api-key mode: pass the key (→ CODEX_API_KEY) and optional base url.
  const codexOpts: CodexOptions = {};
  const env = buildCodexEnv(opts.env);
  if (env) codexOpts.env = env;

  // ── reasoning effort + summaries → thinking blocks ───────────────
  // The Codex CLI's exec path defaults to emitting NO reasoning summary, so
  // gpt-5.x reasoning never surfaces as `reasoning` items and callboard shows no
  // thinking blocks (the model still reasons — `reasoning_output_tokens` > 0 —
  // the summary text is just suppressed). Requesting "auto" (the same default
  // the interactive TUI uses) makes Codex stream `reasoning` items the
  // messageAdapter already translates to `thinking`. Verified empirically against
  // codex 0.139.0: unset ⇒ 0 reasoning items, "auto" ⇒ reasoning text emitted.
  //
  // The per-chat `reasoningEffort` (the OR-style control) tunes this: an explicit
  // "none" suppresses the summary entirely; any real level keeps summaries on and
  // additionally sets the Codex effort tier (below). Default (unset) ⇒ summaries
  // on at Codex's own effort.
  const reasoningEffort = extras.reasoningEffort;
  codexOpts.config = {
    model_reasoning_summary: reasoningEffort === "none" ? "none" : "auto",
  };
  // ── OpenRouter endpoint routing ──────────────────────────────────
  // Inject a custom config.toml model provider so the native Codex harness
  // talks to OpenRouter. wire_api MUST be "responses" (Codex dropped the legacy
  // "chat" value); the key is read from OPENROUTER_API_KEY (set by
  // getApiEnvOverrides). Wins over api-key mode below.
  if (extras.useOpenRouter) {
    codexOpts.config = {
      ...codexOpts.config,
      model_provider: "openrouter",
      model_providers: {
        openrouter: {
          name: "OpenRouter",
          base_url: "https://openrouter.ai/api/v1",
          env_key: "OPENROUTER_API_KEY",
          wire_api: "responses",
        },
      },
    };
  } else if (authMode === "api-key") {
    if (extras.apiKey) codexOpts.apiKey = extras.apiKey;
    if (extras.baseUrl) codexOpts.baseUrl = extras.baseUrl;
  }

  // ── system prompt → temp model_instructions_file ─────────────────
  // Codex's ThreadOptions has no inline instructions field; the prompt rides in
  // via the CLI `model_instructions_file` config (`--config
  // model_instructions_file=<path>`), set on the client `config` bag.
  const instructions = resolveCodexInstructions(opts.systemPrompt);
  const instructionsFilePath = instructions ? writeInstructionsFile(instructions) : null;
  if (instructionsFilePath) {
    codexOpts.config = { ...codexOpts.config, model_instructions_file: instructionsFilePath };
  }

  // ── callboard tools → Codex mcp_servers (the tool bridge) ────────
  // Codex connects OUT to MCP servers; each callboard tool bundle is hosted
  // in-process (buildCodexToolServer) and exposed to Codex as an `mcp_servers`
  // entry pointing at the relay shim. The live handles ride out for cleanup.
  const { config: mcpServersConfig, handles: toolServerHandles } = collectCodexMcpServers(opts.mcpServers);
  if (mcpServersConfig) {
    codexOpts.config = { ...codexOpts.config, mcp_servers: mcpServersConfig };
  }

  // ── thread options (cwd, model, sandbox/approval) ────────────────
  // `skipGitRepoCheck` is always on so Codex runs in non-repo dirs like the
  // other providers (spike §2.1: it's a ThreadOption, not a CodexOption).
  const { sandboxMode, approvalPolicy } = resolveSandboxAndApproval(extras);
  // `none` isn't a Codex effort tier (it only governs summary visibility above);
  // every other EffortLevel maps 1:1 onto Codex's ModelReasoningEffort.
  const modelReasoningEffort =
    reasoningEffort && reasoningEffort !== "none" ? (reasoningEffort as ModelReasoningEffort) : undefined;
  const threadOptions: ThreadOptions = {
    skipGitRepoCheck: true,
    ...(cwd && { workingDirectory: cwd }),
    ...(model && { model }),
    ...(sandboxMode && { sandboxMode }),
    ...(approvalPolicy && { approvalPolicy }),
    ...(modelReasoningEffort && { modelReasoningEffort }),
  };

  log.debug(
    `translateCodexOptions — authMode=${authMode}, resume=${resumeId ?? "none"}, ` +
      `cwd=${cwd ?? "(default)"}, model=${model ?? "(default)"}, ` +
      `sandbox=${sandboxMode ?? "(default)"}, approval=${approvalPolicy ?? "(default)"}, ` +
      `reasoningEffort=${reasoningEffort ?? "(default)"}, ` +
      `instructions=${instructionsFilePath ? `${instructions?.length}chars` : "(none)"}, ` +
      `mcpServers=${mcpServersConfig ? Object.keys(mcpServersConfig).join(",") : "(none)"}, ` +
      `env=${env ? "forwarded" : "(inherit process.env)"}`,
  );

  return { codexOpts, threadOptions, resumeId, instructionsFilePath, authMode, model, toolServerHandles };
}
