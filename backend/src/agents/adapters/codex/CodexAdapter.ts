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
 *  - **buildToolServer()** the MCP-stdio tool bridge (Step 6): Codex is an MCP
 *    *client*, so callboard hosts each tool bundle in-process on a socket and
 *    hands Codex a spawn command for the relay shim (see {@link buildCodexToolServer}).
 *
 * @see plans/codex-adapter-job.md (Step 4 adapter-core, Step 6 tool-bridge)
 * @see plans/codex-spike-findings.md
 */
import { Codex } from "@openai/codex-sdk";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../../ports/AgentProvider.js";
import type { ToolServerSpec } from "../../ports/tools.js";
import { CodexAgentQuery } from "./CodexAgentQuery.js";
import { translateCodexOptions } from "./optionsAdapter.js";
import { buildCodexToolServer } from "./toolAdapter.js";
import { createLogger } from "../../../utils/logger.js";
import { getVisibleCodexModelsAsync } from "../../../services/codex-models.js";

const log = createLogger("codex-adapter");

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
    const { codexOpts, threadOptions, resumeId, instructionsFilePath, toolServerHandles } = translateCodexOptions(options);

    log.debug(`query() — resume=${resumeId ?? "none"}, instructionsFile=${instructionsFilePath ?? "(none)"}, ` + `toolServers=${toolServerHandles.length}`);

    return new CodexAgentQuery({
      codex: new Codex(codexOpts),
      resumeId,
      threadOptions,
      prompt: req.prompt,
      ...(externalSignal && { externalSignal }),
      ...(instructionsFilePath && { instructionsFilePath }),
      toolServerHandles,
      models: async () =>
        (await getVisibleCodexModelsAsync()).map((m) => ({
          value: m.id,
          displayName: m.name,
          description: m.description ?? m.id,
        })),
    });
  }

  /**
   * Stand up an in-process MCP server for `spec` and return its handle. Codex is
   * an MCP *client* — it can't take an in-process tool bundle the way Claude/OR
   * do, so the bundle is served over a socket and reached via the relay shim.
   * claude.ts stores the returned handle in `options.mcpServers[spec.name]`; the
   * optionsAdapter turns it into a `config.mcp_servers` entry and the query
   * closes it when the turn ends.
   */
  buildToolServer(spec: ToolServerSpec): unknown {
    return buildCodexToolServer(spec);
  }
}
