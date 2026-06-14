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
import type { ApprovalMode, CodexOptions, SandboxMode, ThreadOptions } from "@openai/codex-sdk";
import type { DefaultPermissions } from "shared/types/index.js";
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
 * Split the loosely-typed `options.mcpServers` record into the Codex
 * `mcp_servers` config map and the live handles to clean up. Only
 * {@link CodexToolServerHandle}s contribute — any other shape (a stray
 * Claude/OR server object) is logged and skipped rather than mis-serialized into
 * the Codex config.
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
    } else {
      log.warn(`translateCodexOptions — ignoring non-Codex mcp server entry "${name}"`);
    }
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
  if (authMode === "api-key") {
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
  const threadOptions: ThreadOptions = {
    skipGitRepoCheck: true,
    ...(cwd && { workingDirectory: cwd }),
    ...(model && { model }),
    ...(sandboxMode && { sandboxMode }),
    ...(approvalPolicy && { approvalPolicy }),
  };

  log.debug(
    `translateCodexOptions — authMode=${authMode}, resume=${resumeId ?? "none"}, ` +
      `cwd=${cwd ?? "(default)"}, model=${model ?? "(default)"}, ` +
      `sandbox=${sandboxMode ?? "(default)"}, approval=${approvalPolicy ?? "(default)"}, ` +
      `instructions=${instructionsFilePath ? `${instructions?.length}chars` : "(none)"}, ` +
      `mcpServers=${mcpServersConfig ? Object.keys(mcpServersConfig).join(",") : "(none)"}, ` +
      `env=${env ? "forwarded" : "(inherit process.env)"}`,
  );

  return { codexOpts, threadOptions, resumeId, instructionsFilePath, authMode, model, toolServerHandles };
}
