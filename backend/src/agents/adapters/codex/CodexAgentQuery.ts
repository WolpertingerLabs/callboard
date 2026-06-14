/**
 * {@link AgentQuery} backed by a single `@openai/codex-sdk` thread turn.
 *
 * Construction is config-free at the adapter level; everything this query needs
 * — the constructed {@link Codex} client, the resume thread id (or null for a
 * fresh thread), the {@link ThreadOptions}, and the resolved prompt — is passed
 * in by {@link CodexAdapter.query}.
 *
 * Run construction is DEFERRED to first iteration. `query()` must return
 * synchronously (port contract), but `thread.runStreamed()` is async (it spawns
 * the `codex exec` child process and resolves once the event generator is
 * ready), and the prompt may itself be an AsyncIterable that has to be drained
 * to a string first. Both happen lazily inside {@link iterate}, so the async
 * iterator owns all the async setup.
 *
 * **Abort (no native `abort()`, GitHub issue #5494).** The SDK exposes no
 * `Thread.abort()`, but the spike (`plans/codex-spike-findings.md` §TL;DR)
 * found `TurnOptions.signal` is wired straight into the child's
 * `spawn({ signal })` — aborting the signal kills the subprocess and throws
 * `AbortError` out of the event generator. So `close()` aborts an internal
 * controller whose signal is handed to `runStreamed`, which terminates the
 * underlying CLI process. callboard's own abortController (passed via options)
 * is forwarded into the same internal controller, so either path kills the run.
 *
 * @see plans/codex-adapter-job.md (Step 4 adapter-core)
 * @see plans/codex-spike-findings.md
 */
import type { Codex, Input, ThreadOptions } from "@openai/codex-sdk";
import type { AgentQuery } from "../../ports/AgentProvider.js";
import type { AgentEvent } from "../../ports/events.js";
import { translateCodexEvents } from "./messageAdapter.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("codex-adapter");

/**
 * Inputs the adapter resolves once and hands to the query. `resumeId` selects
 * `resumeThread` vs `startThread`; `prompt` may be a string or an async stream
 * of SDK user messages (claude.ts uses the streaming form when MCP servers are
 * present) — it is drained to a Codex {@link Input} at iteration time.
 */
export interface CodexQueryParams {
  codex: Codex;
  resumeId: string | null;
  threadOptions: ThreadOptions;
  prompt: string | AsyncIterable<unknown>;
  /** callboard's run-level abort signal, forwarded into the internal controller. */
  externalSignal?: AbortSignal;
  /** Hardcoded model list surfaced via {@link supportedModels} (no SDK API for this). */
  models: Array<{ value: string; displayName: string; description: string }>;
}

export class CodexAgentQuery implements AgentQuery {
  private readonly abortController = new AbortController();
  private aborted = false;

  constructor(private readonly params: CodexQueryParams) {
    const external = params.externalSignal;
    if (external) {
      if (external.aborted) {
        this.abortController.abort();
      } else {
        external.addEventListener("abort", () => this.abortController.abort(), { once: true });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.iterate()[Symbol.asyncIterator]();
  }

  private async *iterate(): AsyncIterable<AgentEvent> {
    const { codex, resumeId, threadOptions } = this.params;
    log.debug(`iterate() start — resumeId=${resumeId ?? "(new thread)"}, cwd=${threadOptions.workingDirectory ?? "(default)"}`);

    // Resolve the prompt to a Codex Input. A streaming prompt is drained here
    // (it can be async), so the heavy lifting stays off the synchronous query()
    // path.
    let input: Input;
    try {
      input = await resolveCodexInput(this.params.prompt);
    } catch (err) {
      log.error(`prompt resolution failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    // close() may have fired during prompt resolution — don't spawn a turn we'd
    // immediately have to kill.
    if (this.aborted || this.abortController.signal.aborted) {
      log.debug("iterate() aborted before turn start");
      return;
    }

    const thread = resumeId ? codex.resumeThread(resumeId, threadOptions) : codex.startThread(threadOptions);
    log.debug(`iterate() runStreamed — resumeId=${resumeId ?? "(new)"}`);
    const { events } = await thread.runStreamed(input, { signal: this.abortController.signal });

    if (this.aborted || this.abortController.signal.aborted) {
      log.debug("iterate() aborted after runStreamed");
      return;
    }

    yield* translateCodexEvents(events);
    log.debug("iterate() finished");
  }

  async accountInfo(): Promise<Record<string, unknown> | null> {
    // The Codex SDK exposes no account/auth introspection surface. Auth lives
    // in $CODEX_HOME/auth.json and is owned by the CLI; callboard reads it
    // directly for the system-info "configured" check (later slice), not here.
    return null;
  }

  async supportedModels(): Promise<Array<{ value: string; displayName: string; description: string }>> {
    return this.params.models;
  }

  async close(): Promise<void> {
    log.debug(`close() — aborting (issue #5494: no native abort, kill subprocess via signal)`);
    this.aborted = true;
    this.abortController.abort();
  }
}

/**
 * Drain an adapter prompt to a Codex {@link Input}. A plain string passes
 * through; a streaming prompt (the Claude SDK's `AsyncIterable<SDKUserMessage>`,
 * which claude.ts uses when MCP servers are present) is collected to its text
 * content. Image blocks are dropped with a warning — Codex takes images via
 * `local_image` file paths, not inline base64, so wiring multimodal input is a
 * later concern; text is the load-bearing path for adapter-core.
 */
export async function resolveCodexInput(prompt: string | AsyncIterable<unknown>): Promise<Input> {
  if (typeof prompt === "string") return prompt;

  const parts: string[] = [];
  let droppedImages = 0;
  for await (const message of prompt) {
    const content = (message as { message?: { content?: unknown } }).message?.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
          parts.push(String((block as { text?: unknown }).text ?? ""));
        } else {
          droppedImages++;
        }
      }
    }
  }
  if (droppedImages > 0) {
    log.warn(`resolveCodexInput dropped ${droppedImages} non-text block(s) — Codex takes images via local_image paths, not inline`);
  }
  return parts.join("\n");
}
