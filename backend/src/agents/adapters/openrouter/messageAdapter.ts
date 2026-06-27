/**
 * Event translation: openrouter-agent-harness `AgentCoreEvent` →
 * callboard `AgentEvent`.
 *
 * The OR library yields a discriminated union of low-level run events; this
 * adapter projects them onto the callboard-neutral {@link AgentEvent} shape
 * that frontend code already consumes (text/thinking/tool_use/tool_result/
 * result etc.). `reasoning_delta` maps to `thinking` (live reasoning text —
 * same wire shape the Claude adapter produces for thinking deltas).
 * `turn_end` becomes an `adapter_specific` "turn_cost" beacon so the service
 * layer can surface live per-turn spend (see translateEvent). `turn_start`
 * and the bridge `error` event are dropped (their information is folded into
 * the eventual `stream_complete`/`result` payload).
 *
 * A synthetic `slash_commands` event is emitted at session start using a
 * {@link CommandLoader} so the frontend's slash-menu UI works without relying on
 * a wire-level event the OR library does not expose. The adapter passes a loader
 * pre-built with plugin command roots + skill convergence (see commandAdapter);
 * when none is supplied we fall back to a bare project/user `createCommandLoader`
 * so direct callers (and tests) keep working.
 *
 * @see plans/openrouter-adapter.md §3 (event translation table)
 */
import {
  createCommandLoader,
  type AgentCoreEvent,
  type CommandLoader,
  type OpenRouterAgentRun,
} from "@wolpertingerlabs/openrouter-agent-harness";
import type { AgentEvent, TokenUsage } from "../../ports/events.js";
import { describeErrorCause, safeStringify } from "./logFields.js";
import { serverToolName, serverToolOutputContent } from "./serverTools.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("openrouter-events");

/**
 * Drives the OR run's async iteration and yields translated callboard
 * {@link AgentEvent}s. Single-shot — call once per run.
 */
export async function* translateOpenRouterEvents(
  run: OpenRouterAgentRun,
  cwd: string,
  commandLoader?: CommandLoader,
): AsyncIterable<AgentEvent> {
  log.debug(`translateOpenRouterEvents start — cwd=${cwd}`);
  const slashCommands = await tryListSlashCommands(cwd, commandLoader);
  if (slashCommands) yield slashCommands;

  let eventCount = 0;
  try {
    for await (const event of run) {
      eventCount++;
      logEvent(event);
      const translated = translateEvent(event);
      if (Array.isArray(translated)) {
        yield* translated;
      } else if (translated) {
        yield translated;
      }
    }
  } catch (err) {
    log.error(
      `OR run iteration threw after ${eventCount} events: ${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}`,
    );
    throw err;
  }
  log.debug(`translateOpenRouterEvents end — eventCount=${eventCount}`);
}

/**
 * Per-event diagnostic logging. Verbose by design — debug level is the right
 * dial for "show me everything the OR run produced." Errors and bridge
 * `error` events also surface at warn/error so they aren't lost when the log
 * level is info.
 */
function logEvent(event: AgentCoreEvent): void {
  switch (event.type) {
    case "session_started":
      log.debug(`event session_started — sessionId=${event.sessionId}`);
      break;
    case "text_delta":
      log.debug(`event text_delta — chars=${event.content.length}`);
      break;
    case "reasoning_delta":
      log.debug(`event reasoning_delta — chars=${event.content.length}`);
      break;
    case "message_item_start":
      log.debug(
        `event message_item_start — kind=${event.kind}, itemId=${event.itemId}, ` +
          `outputIndex=${event.outputIndex ?? "n/a"}, phase=${event.phase ?? "n/a"}, ` +
          `sessionId=${event.sessionId ?? "n/a"}`,
      );
      break;
    case "tool_call":
      log.debug(`event tool_call — name=${event.name}, callId=${event.callId}`);
      break;
    case "tool_result": {
      const out = event.output;
      const preview =
        typeof out === "string"
          ? out.slice(0, 200)
          : (() => {
              try {
                return JSON.stringify(out).slice(0, 200);
              } catch {
                return String(out).slice(0, 200);
              }
            })();
      log.debug(
        `event tool_result — callId=${event.callId}, isError=${!!event.isError}, preview=${JSON.stringify(preview)}`,
      );
      if (event.isError) {
        log.warn(`tool_result error — callId=${event.callId}, output=${preview}`);
      }
      break;
    }
    case "server_tool": {
      const out = event.output;
      const preview = (() => {
        try {
          return JSON.stringify(out)?.slice(0, 200) ?? String(out).slice(0, 200);
        } catch {
          return String(out).slice(0, 200);
        }
      })();
      log.debug(
        `event server_tool — toolType=${event.toolType}, callId=${event.callId ?? "(none)"}, status=${event.status}, isError=${event.isError}, preview=${JSON.stringify(preview)}`,
      );
      if (event.isError) {
        log.warn(`server_tool error — toolType=${event.toolType}, callId=${event.callId ?? "(none)"}, output=${preview}`);
      }
      break;
    }
    case "turn_start":
      log.debug(`event turn_start`);
      break;
    case "turn_end":
      log.debug(
        `event turn_end — turnNumber=${event.turnNumber}, costUsd=${event.costUsd}, ` +
          `inputTokens=${event.usage?.inputTokens ?? "n/a"}, outputTokens=${event.usage?.outputTokens ?? "n/a"}`,
      );
      break;
    case "error": {
      // Bridge-level error: the OR library always follows with a
      // stream_complete carrying the same reason, but log here too so the
      // wire-order is visible. The cause (HTTP statusCode/body on SDK
      // errors) and the harness's structured `detail` (provider attempts,
      // routing summary — read defensively, older harness versions don't
      // send it) carry the actual upstream failure, so include both.
      const message = (event as { message?: string }).message;
      const detail = (event as { detail?: Record<string, unknown> }).detail;
      log.error(
        `event error — ${message ?? JSON.stringify(event)}` +
          describeErrorCause((event as { cause?: unknown }).cause, message) +
          (detail ? `, detail: ${safeStringify(detail)}` : ""),
      );
      break;
    }
    case "stream_complete":
      if (event.status === "error") {
        log.error(
          `event stream_complete status=error — reason=${event.reason ?? "(none)"}, durationMs=${event.durationMs ?? "n/a"}, costUsd=${event.costUsd ?? "n/a"}`,
        );
      } else if (event.status === "max_turns" || event.status === "max_budget") {
        log.warn(
          `event stream_complete status=${event.status} — reason=${event.reason ?? "(none)"}, durationMs=${event.durationMs ?? "n/a"}, costUsd=${event.costUsd ?? "n/a"}`,
        );
      } else {
        log.debug(
          `event stream_complete status=${event.status} — durationMs=${event.durationMs ?? "n/a"}, costUsd=${event.costUsd ?? "n/a"}, inputTokens=${event.usage?.inputTokens ?? "n/a"}, outputTokens=${event.usage?.outputTokens ?? "n/a"}`,
        );
      }
      break;
  }
}

/**
 * Pure translation of a single {@link AgentCoreEvent} — exported for unit
 * tests that don't want to drive a full run iterator. Returns `null` for
 * variants that should be dropped (turn starts, bridge errors, zero-cost
 * turn ends). One variant fans out: `server_tool` carries both the invocation
 * and its result in a single event, so it translates to a `tool_use` +
 * `tool_result` PAIR (matching how the session/transcript parsers project
 * these onto history — see serverTools.ts).
 */
export function translateEvent(event: AgentCoreEvent): AgentEvent | AgentEvent[] | null {
  switch (event.type) {
    case "session_started":
      return { type: "session_started", sessionId: event.sessionId };
    case "message_item_start":
      // Boundary marker: a NEW discrete `message` (text) or `reasoning`
      // (thinking) output item begins here, BEFORE any of its deltas. Forward
      // it verbatim so the consumer FLUSHES the current live bubble and STARTS
      // a fresh, discrete one — coordinator message, worker message, worker
      // reasoning, etc. each become their own successive chat message. PURELY
      // ADDITIVE: the text_delta/reasoning_delta events that follow are
      // untouched (no trim, no separators, no combining). Tool / server-tool
      // items don't emit this — they flush via their own tool_call /
      // server_tool events — so a new message/reasoning item is signalled ONLY
      // here. `phase`, `outputIndex`, and `sessionId` are passed through only
      // when present (sessionId labels coordinator vs worker provenance).
      return {
        type: "message_item_start",
        kind: event.kind,
        itemId: event.itemId,
        ...(event.outputIndex !== undefined && { outputIndex: event.outputIndex }),
        ...(event.phase !== undefined && { phase: event.phase }),
        ...(event.sessionId !== undefined && { sessionId: event.sessionId }),
      };
    case "text_delta":
      return { type: "text", content: event.content };
    case "reasoning_delta":
      // Live reasoning text from the model — same callboard event the Claude
      // adapter emits for thinking deltas, so claude.ts forwards it as a
      // `thinking` StreamEvent with zero provider-specific handling.
      return { type: "thinking", content: event.content };
    case "tool_call":
      return { type: "tool_use", toolName: event.name, input: event.input, callId: event.callId };
    case "tool_result":
      return {
        type: "tool_result",
        callId: event.callId,
        content: stringifyOutput(event.output),
        isError: event.isError,
      };
    case "server_tool": {
      // OpenRouter server tools (datetime / web_search / web_fetch) execute
      // on OR's servers and arrive as a single event carrying both the
      // invocation and its result. Synthesize the pair with provenance so
      // live rendering matches what the transcript parser produces on
      // refetch. `callId` may be absent (provider-supplied id) — fall back
      // to "" to satisfy the neutral union; nothing downstream keys on it.
      const callId = event.callId ?? "";
      return [
        {
          type: "tool_use",
          toolName: serverToolName(event.toolType),
          input: event.input ?? {},
          callId,
          toolSource: "openrouter_server",
        },
        {
          type: "tool_result",
          callId,
          content: serverToolOutputContent(event.output),
          isError: event.isError,
          toolSource: "openrouter_server",
        },
      ];
    }
    case "stream_complete": {
      const usage = buildUsage(event);
      return {
        type: "result",
        status: event.status,
        ...(event.reason !== undefined && { reason: event.reason }),
        ...(usage !== null && { usage }),
        ...(event.durationMs !== undefined && { durationMs: event.durationMs }),
      };
    }
    case "turn_end":
      // Surface the harness's per-turn cost accounting as an
      // `adapter_specific` "turn_cost" beacon — claude.ts turns it into a
      // live `budget` StreamEvent so the UI can update the spend indicator
      // mid-run instead of waiting for the terminal `done`. `costUsd` is the
      // CUMULATIVE run cost so far (not the turn's increment). Zero /
      // non-finite costs are dropped: providers that don't report cost emit
      // 0 on every turn, and a stream of no-op budget events would just be
      // wire noise.
      if (Number.isFinite(event.costUsd) && event.costUsd > 0) {
        return {
          type: "adapter_specific",
          adapter: "openrouter",
          payload: {
            kind: "turn_cost",
            turnNumber: event.turnNumber,
            costUsd: event.costUsd,
            usage: event.usage,
          },
        };
      }
      return null;
    case "turn_start":
    case "error":
      // Turn starts roll up into the final stream_complete; bridge `error`
      // events are always followed by a stream_complete with status: "error"
      // carrying the same message in `reason`.
      return null;
  }
}

function buildUsage(event: Extract<AgentCoreEvent, { type: "stream_complete" }>): TokenUsage | null {
  if (!event.usage) {
    return event.costUsd !== undefined
      ? { inputTokens: 0, outputTokens: 0, costUsd: event.costUsd }
      : null;
  }
  const usage: TokenUsage = {
    inputTokens: event.usage.inputTokens,
    outputTokens: event.usage.outputTokens,
  };
  // The stream-level `costUsd` is authoritative when present — it's
  // accumulated across the whole run by the OR library; `usage.cost` is
  // the single-response cost which the run-level value may exceed.
  const cost = event.costUsd ?? event.usage.cost ?? undefined;
  if (cost !== undefined && cost !== null) usage.costUsd = cost;
  return usage;
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  try {
    const json = JSON.stringify(output);
    // JSON.stringify silently returns `undefined` (not a throw) for values it
    // can't serialize — Symbol, function, top-level undefined. Fall back to
    // String() so downstream consumers always get a real string.
    if (json === undefined) return String(output);
    return json;
  } catch {
    // JSON.stringify throws on circular refs, BigInt without a toJSON, etc.
    return String(output);
  }
}

async function tryListSlashCommands(
  cwd: string,
  commandLoader?: CommandLoader,
): Promise<AgentEvent | null> {
  try {
    const loader = commandLoader ?? createCommandLoader({ cwd });
    const listing = await loader.list();
    const commands = listing.map((c) => c.name);
    log.debug(`slash command discovery — count=${commands.length}, cwd=${cwd}`);
    // Suppress the synthetic event when no commands are discovered — keeps
    // the iter shape identical to "no commands wired" sessions and matches
    // how the Claude adapter handles missing slash-command init payloads.
    if (commands.length === 0) return null;
    return { type: "slash_commands", commands };
  } catch (err) {
    // Discovery failures are non-fatal — slash commands are a convenience,
    // not a load-bearing feature for the run.
    log.warn(
      `slash command discovery failed — cwd=${cwd}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
