/**
 * Codex adapter — concrete {@link AgentProvider} backed by `@openai/codex-sdk`,
 * the third agent engine alongside claude-code and openrouter.
 *
 * Construction is config-free; per-call configuration rides in on
 * `AgentQueryRequest.options`: top-level `cwd` / `resume` / `abortController`
 * (the same Claude-SDK-shaped fields claude.ts already populates for every
 * provider) plus a `codex` sub-object carrying provider settings (auth mode,
 * api key/base url, model, sandbox mode). The richer
 * options/permission translation is its own slice (Step 5) — this adapter does
 * the minimal mapping needed to start/resume a thread and stream its events.
 *
 * What lands here (Step 4, adapter-core):
 *  - thread **start / resume** via the SDK (`startThread` / `resumeThread`),
 *  - **event translation** into the {@link AgentEvent} union (messageAdapter),
 *  - **close()** that kills the `codex exec` subprocess by aborting the signal
 *    handed to `runStreamed` (no native `abort()` — GitHub issue #5494).
 *
 * Still stubbed: {@link buildToolServer} (the MCP-stdio tool bridge is the
 * highest-risk slice and gets its own step — Step 6).
 *
 * @see plans/codex-adapter-job.md (Step 4 adapter-core)
 * @see plans/codex-spike-findings.md
 */
import { Codex, type CodexOptions, type SandboxMode, type ThreadOptions } from "@openai/codex-sdk";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../../ports/AgentProvider.js";
import type { ToolServerSpec } from "../../ports/tools.js";
import { CodexAgentQuery } from "./CodexAgentQuery.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("codex-adapter");

/**
 * Sub-object on the options Record carrying Codex-specific configuration. Set
 * by claude.ts when routing a call to the Codex adapter (the wiring that
 * populates it lands in a later slice — read defensively here). Mirrors the
 * `openRouter` extras pattern.
 */
export interface CodexOptionsExtras {
  /** Subscription (ChatGPT login) vs raw API key. Default subscription — no key passed. */
  authMode?: "subscription" | "api-key";
  /** OPENAI/Codex API key — only consumed in api-key mode (→ CodexOptions.apiKey → CODEX_API_KEY). */
  apiKey?: string;
  /** Base URL override — api-key mode only (→ CodexOptions.baseUrl). */
  baseUrl?: string;
  /** Default model, e.g. "gpt-5.5". */
  model?: string;
  /** Codex sandbox mode (permission translation is fleshed out in Step 5). */
  sandboxMode?: SandboxMode;
}

/**
 * Hardcoded model list surfaced via {@link AgentQuery.supportedModels}. The
 * Codex SDK has no models endpoint, and a richer (settings-driven) list is a
 * later concern — seed with the gpt-5.x family the spike confirmed
 * (`plans/codex-spike-findings.md`: default model gpt-5.5).
 */
const CODEX_MODELS: Array<{ value: string; displayName: string; description: string }> = [
  { value: "gpt-5.5", displayName: "GPT-5.5", description: "OpenAI Codex default (gpt-5.5)" },
  { value: "gpt-5.1-codex", displayName: "GPT-5.1 Codex", description: "OpenAI Codex (gpt-5.1)" },
];

export class CodexAdapter implements AgentProvider {
  readonly kind = "codex" as const;

  query(req: AgentQueryRequest): AgentQuery {
    const options = req.options;
    const extras = (options.codex ?? {}) as CodexOptionsExtras;

    const cwd = typeof options.cwd === "string" ? options.cwd : undefined;
    const resumeId = typeof options.resume === "string" && options.resume.length > 0 ? options.resume : null;
    const externalSignal = (options.abortController as AbortController | undefined)?.signal;
    const model = extras.model ?? (typeof options.model === "string" ? options.model : undefined);

    // Subscription mode: construct with no apiKey so the SDK picks up
    // $CODEX_HOME/auth.json (auth_mode "chatgpt"). API-key mode: pass the key
    // (SDK → CODEX_API_KEY) and optional base url. Never pass `env` — it would
    // REPLACE process.env entirely (spike §2.3); CODEX_HOME is set on the
    // process env by getApiEnvOverrides, not here.
    const codexOpts: CodexOptions = {};
    if (extras.authMode === "api-key") {
      if (extras.apiKey) codexOpts.apiKey = extras.apiKey;
      if (extras.baseUrl) codexOpts.baseUrl = extras.baseUrl;
    }

    // `skipGitRepoCheck` is a ThreadOption (not a CodexOption — spike §2.1).
    // Always set so Codex runs in non-repo working dirs the way the other
    // providers do.
    const threadOptions: ThreadOptions = {
      skipGitRepoCheck: true,
      ...(cwd && { workingDirectory: cwd }),
      ...(model && { model }),
      ...(extras.sandboxMode && { sandboxMode: extras.sandboxMode }),
    };

    log.debug(
      `query() — authMode=${extras.authMode ?? "subscription"}, resume=${resumeId ?? "none"}, ` +
        `cwd=${cwd ?? "(default)"}, model=${model ?? "(default)"}, sandbox=${extras.sandboxMode ?? "(default)"}`,
    );

    return new CodexAgentQuery({
      codex: new Codex(codexOpts),
      resumeId,
      threadOptions,
      prompt: req.prompt,
      ...(externalSignal && { externalSignal }),
      models: CODEX_MODELS,
    });
  }

  buildToolServer(_spec: ToolServerSpec): unknown {
    // The MCP-stdio tool bridge (Codex connects OUT to MCP servers rather than
    // hosting tools in-process) is the highest-risk piece and lands in its own
    // slice — Step 6 (tool-bridge). Until then, a Codex chat runs with the
    // CLI's built-in tools only.
    throw new Error("CodexAdapter.buildToolServer is not yet implemented (WIP) — see plans/codex-adapter-job.md (Step 6 tool-bridge)");
  }
}
