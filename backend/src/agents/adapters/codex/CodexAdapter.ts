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
import { Codex } from "@openai/codex-sdk";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../../ports/AgentProvider.js";
import type { ToolServerSpec } from "../../ports/tools.js";
import { CodexAgentQuery } from "./CodexAgentQuery.js";
import { translateCodexOptions } from "./optionsAdapter.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("codex-adapter");

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
    const externalSignal = (options.abortController as AbortController | undefined)?.signal;

    // All option/permission translation (auth-mode Codex construction,
    // cwd/model/sandbox/approval, systemPrompt → temp model_instructions_file)
    // lives in the optionsAdapter. The temp instructions file (when written)
    // must outlive this synchronous call — CodexAgentQuery deletes it after the
    // run.
    const { codexOpts, threadOptions, resumeId, instructionsFilePath } = translateCodexOptions(options);

    log.debug(`query() — resume=${resumeId ?? "none"}, instructionsFile=${instructionsFilePath ?? "(none)"}`);

    return new CodexAgentQuery({
      codex: new Codex(codexOpts),
      resumeId,
      threadOptions,
      prompt: req.prompt,
      ...(externalSignal && { externalSignal }),
      ...(instructionsFilePath && { instructionsFilePath }),
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
