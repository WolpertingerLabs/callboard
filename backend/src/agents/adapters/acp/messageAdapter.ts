/**
 * Event translation: ACP `SessionUpdate` → callboard {@link AgentEvent}.
 *
 * ## Contract: this module never throws
 *
 * Everything here runs on data a *third-party binary* put on a pipe. The plan's
 * "capability lies" risk is really a data-shape risk: a vendor that advertises
 * `promptCapabilities.image` but streams a malformed image block, or emits a
 * `sessionUpdate` value this SDK version has never heard of. A throw inside the
 * notification handler would tear down the ACP connection mid-turn and lose the
 * whole run. So every function below is total: unrecognized variants ride out as
 * `adapter_specific`, unusable payloads are dropped with a warn, and the
 * translator returns an array (possibly empty) rather than raising.
 *
 * That is also why the top-level switch is written against a widened
 * `{ sessionUpdate: string }` view rather than the SDK's discriminated union:
 * with the union, TypeScript proves the switch exhaustive and would let a
 * *runtime* value outside the union fall through to nothing. The widened view
 * forces a real `default` branch that exists at runtime.
 *
 * ## Mapping table
 *
 * | ACP `sessionUpdate`         | AgentEvent                                  |
 * | --------------------------- | ------------------------------------------- |
 * | `user_message_chunk`        | *(dropped — callboard already has the prompt)* |
 * | `agent_message_chunk`       | `text`                                      |
 * | `agent_thought_chunk`       | `thinking`                                  |
 * | `tool_call`                 | `tool_use`, deferred until its arguments arrive (+ `tool_result` if born terminal) |
 * | `tool_call_update`          | a deferred `tool_use`, and `tool_result` once terminal |
 * | `available_commands_update` | `slash_commands`                            |
 * | `plan` / `plan_update` (items) / `plan_removed` | `task_list`             |
 * | `plan_update` (file / markdown) | `adapter_specific`                      |
 * | `current_mode_update`       | `adapter_specific`                          |
 * | `config_option_update`      | `adapter_specific`                          |
 * | `session_info_update`       | `adapter_specific`                          |
 * | `usage_update`              | `adapter_specific`, plus a `turn_cost` beacon when it carries a USD cost |
 * | *anything else*             | `adapter_specific`                          |
 *
 * Two mappings deserve their reasoning spelled out:
 *
 * **`user_message_chunk` is dropped.** Agents echo the prompt back so a
 * *fresh* client can render a conversation it did not send. callboard already
 * persisted the user's message before `query()` was called, so re-emitting it
 * would double every user turn in the UI.
 *
 * **`tool_call` is deferred, not translated on arrival.** An agent may open a
 * call before its arguments exist; emitting then would pin `input: {}` for the
 * life of the transcript. See {@link AcpToolCallBuffer}.
 *
 * **`usage_update` is NOT a `result.usage`.** ACP's `UsageUpdate` is
 * `{ used, size }` — *context-window occupancy*, not tokens billed for the turn.
 * Mapping it onto {@link TokenUsage} would put a context-window number in a cost
 * field. Turn accounting comes from `PromptResponse.usage` instead (see
 * {@link buildAcpUsage}); the occupancy signal rides through untouched.
 *
 * @see plans/acp-adapter.md
 * @see ../codex/messageAdapter.ts (the same job for a different wire format)
 */
import type {
  AvailableCommand,
  ContentBlock,
  PlanEntry,
  PlanEntryStatus,
  PlanItems,
  SessionUpdate,
  ToolCallContent,
  ToolCallStatus,
  Usage,
} from "@agentclientprotocol/sdk";
import type { AgentEvent, TaskListItem, TokenUsage } from "../../ports/events.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("acp-events");

/** Adapter tag on every `adapter_specific` event this module emits. */
export const ACP_ADAPTER_TAG = "acp";

/** Statuses that mean a tool call has finished and a `tool_result` is due. */
const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set<ToolCallStatus>(["completed", "failed"]);

function adapterSpecific(kind: string, payload: unknown): AgentEvent {
  return { type: "adapter_specific", adapter: ACP_ADAPTER_TAG, payload: { kind, ...(payload && typeof payload === "object" ? payload : { value: payload }) } };
}

/**
 * Flatten one ACP {@link ContentBlock} to display text.
 *
 * Text passes through. Non-text blocks are summarized rather than dropped —
 * an empty string in the transcript is indistinguishable from the agent saying
 * nothing, whereas `[image image/png]` is honest about what arrived.
 */
export function contentBlockToText(block: ContentBlock | null | undefined): string {
  if (!block || typeof block !== "object") return "";
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "image":
      return `[image ${typeof block.mimeType === "string" ? block.mimeType : "unknown"}]`;
    case "audio":
      return `[audio ${typeof block.mimeType === "string" ? block.mimeType : "unknown"}]`;
    case "resource_link":
      return typeof block.uri === "string" && block.uri ? `[resource_link ${block.uri}]` : "[resource_link]";
    case "resource":
      return resourceToText(block);
    default:
      // A block type newer than this SDK pin. Keep something readable.
      return `[${String((block as { type?: unknown }).type ?? "unknown")}]`;
  }
}

function resourceToText(block: Extract<ContentBlock, { type: "resource" }>): string {
  const resource = (block as { resource?: unknown }).resource;
  if (resource && typeof resource === "object") {
    const r = resource as { text?: unknown; uri?: unknown };
    if (typeof r.text === "string") return r.text;
    if (typeof r.uri === "string") return `[resource ${r.uri}]`;
  }
  return "[resource]";
}

/**
 * Flatten `ToolCallContent[]` (the tool's output) to a single string.
 *
 * `diff` blocks are rendered as a compact header rather than a full unified
 * diff: ACP hands us `{path, oldText, newText}`, and synthesizing diff syntax
 * from that would be inventing formatting the agent never sent.
 */
export function toolContentToText(content: readonly ToolCallContent[] | null | undefined): string {
  if (!Array.isArray(content) || content.length === 0) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    switch (item.type) {
      case "content":
        parts.push(contentBlockToText(item.content));
        break;
      case "diff": {
        const path = typeof item.path === "string" ? item.path : "(unknown path)";
        const added = typeof item.newText === "string" ? item.newText.split("\n").length : 0;
        const removed = typeof item.oldText === "string" ? item.oldText.split("\n").length : 0;
        parts.push(`[diff ${path} +${added}/-${removed}]`);
        break;
      }
      case "terminal":
        parts.push(typeof item.terminalId === "string" && item.terminalId ? `[terminal ${item.terminalId}]` : "[terminal]");
        break;
      default:
        parts.push(`[${String((item as { type?: unknown }).type ?? "unknown")}]`);
        break;
    }
  }
  return parts.filter((p) => p.length > 0).join("\n");
}

/** Tool display name: the experimental `name` when present, else the title. */
function toolName(update: { name?: string | null; title?: string | null }): string {
  const name = typeof update.name === "string" ? update.name.trim() : "";
  if (name) return name;
  const title = typeof update.title === "string" ? update.title.trim() : "";
  return title || "tool";
}

/**
 * Holds a `tool_use` back until the call's arguments are known.
 *
 * ACP lets an agent open a tool call before it has settled the arguments, and
 * OpenCode does exactly that: `tool_call` arrives with `rawInput: {}` and the
 * real `{filePath, content}` lands on the *next* `tool_call_update`. callboard's
 * `tool_use` is a one-shot event with no callId on the wire (see the
 * `StreamEvent` mapping in `services/claude.ts`), so a second, fuller `tool_use`
 * would render as a second tool card rather than an amendment. Emitting early
 * therefore means emitting `{}` forever — every OpenCode tool in the transcript
 * showing no file, no command, no arguments at all.
 *
 * So the first `tool_use` waits for the first non-empty `rawInput`. The label
 * comes from the opening `tool_call` (`"write"`), not from the update whose
 * `title` OpenCode later rewrites to the file path.
 *
 * Bounded by construction: entries leave on the call's first argument-bearing
 * update, on its terminal update, or on {@link flush} at the end of the turn.
 * A call is never held past the turn that opened it.
 */
export class AcpToolCallBuffer {
  private readonly held = new Map<string, string>();

  /** Remember a call whose arguments have not arrived yet. */
  hold(callId: string, toolName: string): void {
    this.held.set(callId, toolName);
  }

  /** The held `tool_use` for this call, now that there is something to say. */
  release(callId: string, input: Record<string, unknown>): AgentEvent[] {
    const toolName = this.held.get(callId);
    if (toolName === undefined) return [];
    this.held.delete(callId);
    return [{ type: "tool_use", toolName, input, callId }];
  }

  /**
   * Everything still held, in the order it was opened.
   *
   * A turn that ends with calls still held means the agent opened them and never
   * updated them. They still happened, so they are emitted argument-less rather
   * than dropped — an absent tool call is a worse lie than an empty one.
   */
  flush(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const [callId, toolName] of this.held) events.push({ type: "tool_use", toolName, input: {}, callId });
    this.held.clear();
    return events;
  }
}

/** `rawInput` as a non-empty object, or null when there is nothing to report. */
function argumentsOf(rawInput: unknown): Record<string, unknown> | null {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return null;
  const record = rawInput as Record<string, unknown>;
  return Object.keys(record).length > 0 ? record : null;
}

/**
 * Translate one `SessionUpdate` into zero or more {@link AgentEvent}s.
 *
 * Exported so tests can assert the mapping table directly without standing up a
 * connection. Total by construction — see the module doc-comment.
 *
 * `buffer` carries the only state translation needs: which tool calls are open
 * but not yet argument-bearing (see {@link AcpToolCallBuffer}). It belongs to one
 * turn, and the caller flushes it when the turn ends.
 */
export function translateAcpUpdate(update: SessionUpdate | null | undefined, buffer: AcpToolCallBuffer): AgentEvent[] {
  if (!update || typeof update !== "object") {
    log.warn("dropped a session/update with no update payload");
    return [];
  }
  // Widened on purpose: the runtime value may be outside this SDK pin's union,
  // and we need a `default` branch that actually exists at runtime.
  const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
  if (typeof kind !== "string") {
    log.warn("dropped a session/update with a non-string sessionUpdate discriminator");
    return [];
  }

  try {
    return translateKnownUpdate(kind, update, buffer);
  } catch (err) {
    // Belt-and-braces: a shape we mis-guessed must not kill the connection.
    log.warn(`session/update "${kind}" failed to translate — riding through as adapter_specific: ${err instanceof Error ? err.message : String(err)}`);
    return [adapterSpecific("untranslatable", { sessionUpdate: kind })];
  }
}

function translateKnownUpdate(kind: string, update: SessionUpdate, buffer: AcpToolCallBuffer): AgentEvent[] {
  switch (kind) {
    case "user_message_chunk":
      // callboard already stored the user's message; echoing it would duplicate.
      return [];

    case "agent_message_chunk": {
      const text = contentBlockToText((update as Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }>).content);
      return text ? [{ type: "text", content: text }] : [];
    }

    case "agent_thought_chunk": {
      const text = contentBlockToText((update as Extract<SessionUpdate, { sessionUpdate: "agent_thought_chunk" }>).content);
      return text ? [{ type: "thinking", content: text }] : [];
    }

    case "tool_call":
      return translateToolCall(update as Extract<SessionUpdate, { sessionUpdate: "tool_call" }>, buffer);

    case "tool_call_update":
      return translateToolCallUpdate(update as Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>, buffer);

    case "available_commands_update": {
      const raw = (update as Extract<SessionUpdate, { sessionUpdate: "available_commands_update" }>).availableCommands;
      const commands = Array.isArray(raw) ? raw.map(commandName).filter((n): n is string => !!n) : [];
      return commands.length > 0 ? [{ type: "slash_commands", commands }] : [];
    }

    case "usage_update": {
      // Rides through like its neighbours, plus a cost beacon when the agent
      // reported one — see `acpTurnCost`.
      const passthrough = adapterSpecific(kind, stripDiscriminator(update));
      const cost = acpTurnCost((update as { cost?: unknown }).cost);
      return cost === null ? [passthrough] : [passthrough, adapterSpecific("turn_cost", { costUsd: cost })];
    }

    case "plan":
    case "plan_update":
    case "plan_removed":
      return translatePlan(kind, update);

    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
      // Real, well-formed ACP signals with no home in the core AgentEvent union.
      // Riding them through keeps the data available to any future consumer
      // without inventing event types the frontend does not render.
      return [adapterSpecific(kind, stripDiscriminator(update))];

    default:
      log.debug(`unrecognized sessionUpdate "${kind}" — riding through as adapter_specific`);
      return [adapterSpecific(kind, stripDiscriminator(update))];
  }
}

/** The three statuses ACP's `PlanEntryStatus` allows. Anything else is not a plan entry. */
const PLAN_ENTRY_STATUSES: ReadonlySet<string> = new Set<PlanEntryStatus>(["pending", "in_progress", "completed"]);

/**
 * The three plan updates → one {@link AgentEvent} `task_list` each.
 *
 * ACP has two generations of this signal and they do not share a shape:
 *
 *  - **`plan`** is the stable one: `{entries}`, a *complete* list every time
 *    ("the client replaces the entire plan with each update" — schema.json).
 *    Its `PlanEntry` is already `{content, status}` in callboard's own
 *    vocabulary, so translation is a filter, not a mapping.
 *  - **`plan_update` / `plan_removed`** are marked UNSTABLE in the SDK and are
 *    keyed by `planId`, so a session may carry several plans at once. Only the
 *    `items` form has entries; `file` and `markdown` plans are a URI and a blob
 *    of prose, neither of which is a checklist, so those ride through as
 *    `adapter_specific` rather than being flattened into rows they are not.
 *
 * `plan_removed` becomes an empty snapshot. That is the whole reason `task_list`
 * is defined as replace-not-merge: a removal has to be able to say "there is no
 * list now", and a delta-shaped event could only ever add.
 *
 * **No plan registry — and `planId` is therefore discarded below.** Several
 * concurrent plans would need one to render a union; what this does instead is
 * treat the newest snapshot as the whole truth, which for two live plans means
 * the bubble flip-flops between them and removing either blanks both.
 *
 * That is a real bug in this code and it is worth being exact about why it can't
 * fire, because the reason is not "no agent does this yet" — an agent's
 * behaviour is not something callboard controls. It is structural: `plan_update`
 * and `plan_removed` are gated on the client advertising `ClientCapabilities`
 * `plan`, and callboard's `BASE_CLIENT_CAPABILITIES` does not. A spec-conforming
 * agent cannot send either update to us, so the two branches below are
 * unreachable by construction rather than by luck, and the tests covering them
 * pin translation shape only — read them as documentation of the mapping, not as
 * coverage of a live path.
 *
 * The one way to reach them is to add `plan: {}` in `AcpAgentClient.ts`, which
 * is exactly why a test in `listTracking.test.ts` fails the moment anyone does:
 * this registry is the prerequisite, not a follow-up. The `log.warn` below is
 * the same tripwire pointed at production, in case an agent ignores the gate.
 */
function translatePlan(kind: string, update: SessionUpdate): AgentEvent[] {
  const planId = (update as { planId?: unknown; plan?: { planId?: unknown } }).planId ?? (update as { plan?: { planId?: unknown } }).plan?.planId;
  if (typeof planId === "string") {
    log.warn(
      `ACP sent a planId-keyed "${kind}" update (planId=${planId}) — callboard advertises no "plan" capability and does not track planId, ` +
        `so this snapshot will overwrite any other live plan. See translatePlan in acp/messageAdapter.ts.`,
    );
  }

  if (kind === "plan_removed") return [{ type: "task_list", items: [] }];

  if (kind === "plan") {
    return [{ type: "task_list", items: planEntries((update as Extract<SessionUpdate, { sessionUpdate: "plan" }>).entries) }];
  }

  const plan = (update as Extract<SessionUpdate, { sessionUpdate: "plan_update" }>).plan;
  if (!plan || typeof plan !== "object" || (plan as { type?: unknown }).type !== "items") {
    return [adapterSpecific(kind, stripDiscriminator(update))];
  }
  return [{ type: "task_list", items: planEntries((plan as PlanItems).entries) }];
}

/**
 * `PlanEntry[]` → `TaskListItem[]`, dropping entries a vendor sent malformed.
 *
 * Dropped rather than defaulted: a row with no text is not a task, and guessing
 * a status would put a step in the wrong column of a list the user reads to
 * know what the agent is doing.
 */
function planEntries(entries: readonly PlanEntry[] | null | undefined): TaskListItem[] {
  if (!Array.isArray(entries)) return [];
  const items: TaskListItem[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const { content, status } = entry as { content?: unknown; status?: unknown };
    if (typeof content !== "string" || !content.trim()) continue;
    if (typeof status !== "string" || !PLAN_ENTRY_STATUSES.has(status)) continue;
    items.push({ content, status: status as TaskListItem["status"] });
  }
  return items;
}

/**
 * ACP's cumulative session cost, in USD, or null when there is nothing usable.
 *
 * `UsageUpdate.cost` is `{amount, currency}` with an ISO 4217 code, and it is
 * **cumulative for the session** rather than for the turn — the same semantics
 * the OpenRouter adapter's `turn_cost` beacon already carries, which is why this
 * reuses that kind rather than inventing a second one. `services/claude.ts`
 * forwards it as a live `budget` StreamEvent, so an ACP chat moves the spend
 * indicator mid-run like every other provider.
 *
 * **Only USD passes.** The field it feeds is named `costUsd` and the UI renders
 * it with a dollar sign, so a vendor billing in EUR would have its number
 * relabelled rather than converted. Showing no cost is the honest outcome there;
 * a wrong currency is worse than a missing one. Zero is a real answer and is
 * reported — OpenCode's free models genuinely cost nothing, and suppressing that
 * would look like "no data" instead of "no charge".
 */
export function acpTurnCost(cost: unknown): number | null {
  if (!cost || typeof cost !== "object") return null;
  const { amount, currency } = cost as { amount?: unknown; currency?: unknown };
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  if (typeof currency !== "string" || currency.trim().toUpperCase() !== "USD") return null;
  return amount;
}

function commandName(command: AvailableCommand | null | undefined): string | null {
  if (!command || typeof command !== "object") return null;
  const name = (command as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** Drop the discriminator so the `adapter_specific` payload is just the data. */
function stripDiscriminator(update: SessionUpdate): Record<string, unknown> {
  const { sessionUpdate: _ignored, ...rest } = update as Record<string, unknown> & { sessionUpdate: string };
  return rest;
}

/**
 * `tool_call` opens a call → `tool_use`.
 *
 * Some agents announce a call that has *already finished* (a cached read, a
 * trivially-satisfied lookup) by sending a single `tool_call` with a terminal
 * status and its content attached, and never send a `tool_call_update`. Emitting
 * only `tool_use` there would leave the call spinning in the UI forever, so a
 * born-terminal call also emits its `tool_result` immediately.
 */
function translateToolCall(update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>, buffer: AcpToolCallBuffer): AgentEvent[] {
  const callId = typeof update.toolCallId === "string" ? update.toolCallId : "";
  if (!callId) {
    log.warn("dropped a tool_call with no toolCallId");
    return [];
  }
  const label = toolName(update);
  const args = argumentsOf(update.rawInput);
  const terminal = typeof update.status === "string" && TERMINAL_TOOL_STATUSES.has(update.status);

  // A call that is already over gets no second chance at arguments, so it is
  // emitted with whatever it arrived with.
  if (!terminal && !args) {
    buffer.hold(callId, label);
    return [];
  }

  const events: AgentEvent[] = [{ type: "tool_use", toolName: label, input: args ?? {}, callId }];
  if (terminal) {
    events.push({ type: "tool_result", callId, content: toolContentToText(update.content), isError: update.status === "failed" });
  }
  return events;
}

/**
 * `tool_call_update` carries incremental state. Only the terminal transition
 * produces an event: intermediate `in_progress` updates would each emit another
 * `tool_result` for the same `callId` and the UI would render the tool finishing
 * repeatedly.
 */
function translateToolCallUpdate(update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>, buffer: AcpToolCallBuffer): AgentEvent[] {
  const callId = typeof update.toolCallId === "string" ? update.toolCallId : "";
  if (!callId) {
    log.warn("dropped a tool_call_update with no toolCallId");
    return [];
  }
  const status = typeof update.status === "string" ? update.status : "";
  const terminal = TERMINAL_TOOL_STATUSES.has(status);
  const args = argumentsOf(update.rawInput);

  // Release a held call as soon as it has something to say — on its arguments if
  // they ever arrive, on its ending if they never do. `release` is a no-op for a
  // call whose `tool_use` already went out, so a mid-turn update carrying
  // arguments for an already-emitted call adds nothing rather than duplicating.
  const events: AgentEvent[] = args ? buffer.release(callId, args) : terminal ? buffer.release(callId, {}) : [];

  if (terminal) {
    events.push({ type: "tool_result", callId, content: toolContentToText(update.content), isError: status === "failed" });
  }
  return events;
}

/**
 * Project ACP's `PromptResponse.usage` onto {@link TokenUsage}.
 *
 * ACP reports no monetary cost on `Usage`, so `costUsd` stays undefined (the UI
 * guards on it). `thoughtTokens` are already included in `outputTokens` per the
 * schema's accounting, so they ride along as `reasoningTokens` — a breakdown —
 * and are never added to the output total.
 *
 * `cachedReadTokens` / `cachedWriteTokens` are `number | null | undefined` in
 * the schema, and the three are **not** interchangeable here: a number (zero
 * included) is a measurement the agent made and is passed through, while
 * null/absent means this agent does not report the figure and must stay
 * undefined so the debug panel renders a dash instead of a fabricated zero.
 * OpenCode reports both; a vendor that reports neither shows blank columns.
 */
export function buildAcpUsage(usage: Usage | null | undefined): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  const outputTokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
  return {
    inputTokens,
    outputTokens,
    ...(reportedCount(usage.cachedReadTokens) !== undefined && { cacheReadTokens: reportedCount(usage.cachedReadTokens) }),
    ...(reportedCount(usage.cachedWriteTokens) !== undefined && { cacheWriteTokens: reportedCount(usage.cachedWriteTokens) }),
    ...(reportedCount(usage.thoughtTokens) !== undefined && { reasoningTokens: reportedCount(usage.thoughtTokens) }),
  };
}

/** A finite count the agent actually reported, or undefined for null/absent/NaN. */
function reportedCount(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Project ACP's `StopReason` onto the terminal {@link AgentEvent} `result`.
 *
 * `end_turn` is the only clean success. `cancelled` is reported as a success
 * too — the run stopped because callboard asked it to, and surfacing a user's
 * own stop button as an error would be wrong — but carries a reason so callers
 * can tell the two apart. `refusal` is an error: the agent declined, and the
 * turn produced nothing the user asked for.
 *
 * An unrecognized reason (a vendor inventing one, or an SDK version newer than
 * this pin) resolves to `error` with the raw string preserved, rather than being
 * silently reported as success.
 *
 * The raw label also rides through on `result.stopReason`, untranslated. The
 * four-value `status` is callboard's control-flow classification and is lossy
 * by design — `max_tokens` and `max_turn_requests` both land on `max_turns` —
 * whereas the responses debug panel wants the thing the agent actually said.
 * ACP's vocabulary happens to already be Anthropic's for the two values that
 * overlap (`end_turn`, `max_tokens`), so no mapping is needed or wanted; a
 * vendor's unrecognized token is shown as-is rather than guessed at. Only a
 * genuinely absent reason (null/undefined) leaves the field unset.
 */
export function mapStopReason(stopReason: string | null | undefined): AgentEvent & { type: "result" } {
  const raw = typeof stopReason === "string" && stopReason ? { stopReason } : {};
  switch (stopReason) {
    case "end_turn":
      return { type: "result", status: "success", ...raw };
    case "cancelled":
      return { type: "result", status: "success", reason: "cancelled", ...raw };
    case "max_tokens":
      return { type: "result", status: "max_turns", reason: "Agent stopped: max tokens reached", ...raw };
    case "max_turn_requests":
      return { type: "result", status: "max_turns", reason: "Agent stopped: max requests per turn reached", ...raw };
    case "refusal":
      return { type: "result", status: "error", reason: "Agent refused the request", ...raw };
    default:
      return { type: "result", status: "error", reason: `Agent stopped with unrecognized reason "${String(stopReason)}"`, ...raw };
  }
}
