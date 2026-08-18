/**
 * Claude Code session log parser — reads and parses the JSONL session
 * logs that the Claude Agent SDK writes to ~/.claude/projects/.
 *
 * Extracted from routes/chats.ts so the ClaudeCodeSessionProvider can
 * own the full read → parse pipeline. The route module still calls these
 * functions directly during the strangler migration (Phase 2); once
 * callers are migrated to the SessionProvider interface, these become
 * private to the adapter.
 *
 * @see plans/agent-abstraction-layer.md
 */
import { readFileSync } from "fs";
import type { ParsedMessage } from "shared/types/index.js";
import { storeBase64Image } from "../../../services/image-storage.js";

// ── CLI plumbing filters ────────────────────────────────────────────

/**
 * Text the CLI injects, verbatim, as the model's reply to its own resume
 * nudge. Dropped only when it directly follows a hidden `isMeta` prompt, so a
 * turn where the model actually continued the work is never lost. A survey of
 * 1529 local session logs found the nudge 52 times and this exact reply
 * following it in all 52.
 */
const META_PROMPT_ACK = "No response requested.";

/**
 * The CLI's interruption records, written as `user` messages. Matched exactly
 * — assistant prose about something being "interrupted" must stay untouched.
 */
const INTERRUPT_MARKERS: ReadonlySet<string> = new Set(["[Request interrupted by user]", "[Request interrupted by user for tool use]"]);

// ── Background task notifications ───────────────────────────────────

/**
 * When a background task finishes — a Bash shell started with
 * `run_in_background`, or a subagent, which the Agent tool backgrounds by
 * default — the CLI does **not** resolve the original `tool_use`. It enqueues
 * a `<task-notification>` blob as a *prompt*, which reaches the JSONL in three
 * places, all carrying the same payload:
 *
 *   0. `type: "queue-operation"`, `operation: "enqueue"` — written the moment
 *      the task finishes. Always present, and the only trace left when the
 *      session ends before the queue drains.
 *   1. `type: "attachment"` with `attachment.commandMode === "task-notification"`
 *      — the notice being consumed mid-turn, while the agent is still working.
 *   2. `type: "user"` with the blob as its whole string content — the shape
 *      used when the queue is flushed on resume, typically carrying the
 *      "these tasks were orphaned" summary.
 *
 * 0 and 1 carry no `message.content` blocks, so they used to fall straight
 * through this parser and render nothing: the agent, which *does* receive
 * them, would announce a result the user never saw finish. Shape 2 did render
 * — as a user bubble of raw XML, putting markup in the user's mouth.
 *
 * All three are normalised into one `subtype: "background_task"` system
 * marker, the same treatment compaction and interruption boundaries get, and
 * deduped on the payload so a notice recorded more than once shows up once.
 */
const TASK_NOTIFICATION_OPEN = "<task-notification>";
const TASK_NOTIFICATION_CLOSE = "</task-notification>";

/** Task ids the CLI uses for its own bookkeeping rather than a real task. */
const INTERNAL_TASK_ID_PREFIX = "__orphan_summary__";

interface TaskNotification {
  /** Human-readable line to show, from `<summary>` or synthesised from ids. */
  summary: string;
  /** `completed`, `failed`, `stopped`, … when the notice declares one. */
  status?: string;
  /** The `tool_use` this notice reports on, when it names a single one. */
  toolUseId?: string;
  /** The background task this notice reports on, when it names a single one. */
  taskId?: string;
  /**
   * Every task this notice accounts for, however many. Distinct from `taskId`
   * on purpose: attribution needs exactly one, but *settling* a task only needs
   * to know it was accounted for. The resume-time orphan notice names one id
   * per orphaned task, and treating a two-task notice as naming nothing left
   * both of them looking like they were still running.
   */
  taskIds: string[];
  /** Identity for dedup — a notice can arrive as both shapes above. */
  key: string;
}

/** All values of a repeated simple tag, in document order, trimmed. */
function tagValues(xml: string, tag: string): string[] {
  const matches = xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"));
  return [...matches].map((m) => m[1].trim()).filter(Boolean);
}

/**
 * Parse a `<task-notification>` payload. Returns null for anything that isn't
 * one, so callers can pass arbitrary content through without pre-checking.
 */
function parseTaskNotification(raw: unknown): TaskNotification | null {
  if (typeof raw !== "string") return null;
  // Whole-payload match, not a substring one: the CLI always writes the blob
  // as the entire content, so anything merely *containing* the tag is prose —
  // a user asking why `<task-notification>` renders oddly is a real message.
  const trimmed = raw.trim();
  if (!trimmed.startsWith(TASK_NOTIFICATION_OPEN) || !trimmed.endsWith(TASK_NOTIFICATION_CLOSE)) return null;

  const status = tagValues(trimmed, "status")[0];
  const toolUseIds = tagValues(trimmed, "tool-use-id");
  const taskIds = tagValues(trimmed, "task-id").filter((id) => !id.startsWith(INTERNAL_TASK_ID_PREFIX));
  // The CLI's own summary is already written for a human ("Background command
  // "npm test" completed (exit code 0)"), so prefer it verbatim.
  const summary = tagValues(trimmed, "summary").join(" ");

  const fallback = taskIds.length > 0 ? `Background task ${taskIds.join(", ")} ${status || "reported"}` : `Background task ${status || "reported"}`;

  return {
    summary: summary || fallback,
    ...(status && { status }),
    // Only when the notice reports on exactly one call — a multi-task summary
    // must not be attributed to whichever id happened to come first.
    ...(toolUseIds.length === 1 && { toolUseId: toolUseIds[0] }),
    ...(taskIds.length === 1 && { taskId: taskIds[0] }),
    taskIds,
    key: trimmed,
  };
}

/** Flatten JSONL message content (string or block array) to its plain text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: any) => (b?.type === "text" ? (b.text ?? "") : "")).join("");
}

/** True when the entry is a text-only turn whose whole text is `expected`. */
function isTextOnlySaying(content: unknown, expected: string): boolean {
  if (Array.isArray(content) && !content.every((b: any) => b?.type === "text")) return false;
  return contentText(content).trim() === expected;
}

// ── Raw JSONL reading ───────────────────────────────────────────────

/**
 * Read a JSONL file and return an array of parsed objects.
 * Returns empty array on any read or parse error.
 */
export function readJsonlFile(path: string): any[] {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── First user message extraction ───────────────────────────────────

/**
 * Extract the first user message from a session JSONL file.
 * Used for chat list preview text.
 */
export function getFirstUserMessage(filePath: string, maxLength: number = 200): string | null {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "user" && msg.message?.role === "user") {
          const content = msg.message.content;
          if (typeof content === "string") {
            return content.substring(0, maxLength);
          }
          if (Array.isArray(content)) {
            const textBlock = content.find((b: any) => b.type === "text");
            if (textBlock?.text) {
              return textBlock.text.substring(0, maxLength);
            }
          }
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Tool result content coercion ────────────────────────────────────

/**
 * Coerce a tool_result block into display text, interning any base64 image
 * blocks (e.g. from Read on an image file) into the shared image store so
 * the frontend can render them as thumbnails instead of a stringified blob.
 */
function extractToolResultContent(block: any): { content: string; imageIds: string[] } {
  const imageIds: string[] = [];
  if (typeof block.content === "string") return { content: block.content, imageIds };
  if (Array.isArray(block.content)) {
    const content = block.content
      .map((c: any) => {
        if (typeof c === "string") return c;
        if (c.type === "text") return c.text;
        if (c.type === "image" && c.source?.type === "base64" && c.source.data && c.source.media_type) {
          const imageId = storeBase64Image(c.source.data, c.source.media_type);
          if (imageId) {
            imageIds.push(imageId);
            return `[Image: ${c.source.media_type}]`;
          }
        }
        return JSON.stringify(c);
      })
      .join("\n");
    return { content, imageIds };
  }
  return { content: JSON.stringify(block.content), imageIds };
}

// ── Subagent map building ───────────────────────────────────────────

/**
 * Build a mapping from agentId to a human-readable display name.
 * Scans parent JSONL lines for Task tool_use blocks (which have input.description)
 * and their corresponding tool_result lines (which have toolUseResult.agentId).
 */
export function buildSubagentMap(rawMessages: any[]): Map<string, string> {
  const toolUseDescriptions = new Map<string, string>(); // tool_use block id -> description
  const agentDescriptions = new Map<string, string>(); // agentId -> description

  for (const msg of rawMessages) {
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    // Capture Task tool_use descriptions
    for (const block of content) {
      if (block.type === "tool_use" && block.name === "Task" && block.input?.description) {
        toolUseDescriptions.set(block.id, block.input.description);
      }
    }

    // The toolUseResult field is on the JSONL line itself (not inside message.content)
    if (msg.toolUseResult?.agentId) {
      // Find the tool_use_id from the tool_result block in this line's content
      const toolResultBlock = Array.isArray(content) ? content.find((b: any) => b.type === "tool_result") : undefined;
      const toolUseId = toolResultBlock?.tool_use_id;
      const desc = toolUseId ? toolUseDescriptions.get(toolUseId) : undefined;
      agentDescriptions.set(msg.toolUseResult.agentId, desc || `Agent ${msg.toolUseResult.agentId}`);
    }
  }

  return agentDescriptions;
}

// ── Message parsing ─────────────────────────────────────────────────

/**
 * Parse raw JSONL messages into the neutral ParsedMessage format.
 *
 * Handles Claude's JSONL schema: message.content arrays with text/thinking/
 * tool_use/tool_result blocks, _sessionId boundaries, compact_boundary,
 * metadata extraction, image dedup, and inter-message timing.
 */
export function parseMessages(rawMessages: any[]): ParsedMessage[] {
  const result: ParsedMessage[] = [];
  let currentSessionId: string | null = null;
  // Set when an `isMeta` prompt was just dropped, so the canned reply the CLI
  // draws out of the model can be dropped with it. Survives the non-message
  // entries (attachment / last-prompt / queue-operation) that sit between
  // them, and is cleared by the first real message either way.
  let afterMetaPrompt = false;
  // A single background-task notice can be recorded as both an attachment and
  // a user message; keyed on the payload so it is rendered exactly once.
  const seenTaskNotifications = new Set<string>();

  /** Push the one system marker a background-task notice renders as. */
  const pushTaskNotification = (notification: TaskNotification, timestamp: string | undefined): void => {
    if (seenTaskNotifications.has(notification.key)) return;
    seenTaskNotifications.add(notification.key);
    result.push({
      role: "system",
      type: "system",
      content: notification.summary,
      subtype: "background_task",
      ...(notification.status && { backgroundTaskStatus: notification.status }),
      ...(notification.toolUseId && { toolUseId: notification.toolUseId }),
      ...(notification.taskId && { backgroundTaskId: notification.taskId }),
      ...(notification.taskIds.length > 0 && { backgroundTaskIds: notification.taskIds }),
      timestamp,
    });
  };

  for (const msg of rawMessages) {
    // Detect session boundary — inject a "Conversation was cleared" marker
    if (msg._sessionId && currentSessionId && msg._sessionId !== currentSessionId) {
      result.push({
        role: "system",
        type: "system",
        content: "Conversation was cleared",
        subtype: "clear_boundary",
        timestamp: msg.timestamp,
      });
    }
    if (msg._sessionId) currentSessionId = msg._sessionId;

    // Skip internal metadata lines
    if (msg.type === "summary") continue;

    // The CLI's prompt-queue bookkeeping. An `enqueue` carries the whole
    // notification payload and is written the moment the task finishes, so it
    // is both the earliest and the most reliable record of it — and for a task
    // whose notice is never delivered (the session ended before the queue
    // drained) it is the *only* record: no attachment or prompt line is ever
    // written. The matching remove/dequeue lines repeat the same payload, as
    // do the delivery shapes below; `pushTaskNotification` dedups on the
    // payload so the marker still renders exactly once.
    if (msg.type === "queue-operation") {
      if (msg.operation === "enqueue") {
        const notification = parseTaskNotification(msg.content);
        if (notification) pushTaskNotification(notification, msg.timestamp);
      }
      continue;
    }

    // Shape 1: a background task reporting in mid-turn. Attachment records
    // carry no `message.content`, so every branch below drops them — this one
    // has to be read before that happens. Non-notification attachments
    // (task_reminder, deferred_tools_delta, …) stay dropped, as before.
    if (msg.type === "attachment") {
      const notification = parseTaskNotification(msg.attachment?.prompt);
      if (notification) pushTaskNotification(notification, msg.timestamp);
      continue;
    }

    // Drop CLI plumbing the user never wrote. `isMeta` marks entries the CLI
    // injects itself: the "Continue from where you left off." nudge it adds
    // when resuming an interrupted session, slash-command argument blocks,
    // skill preambles, image-dimension notes. They arrive with role "user",
    // so rendering them puts words in the user's mouth — most visibly when a
    // follow-up message interrupts a running turn, which sandwiches two of
    // them between the two messages the user actually sent.
    if (msg.isMeta) {
      afterMetaPrompt = true;
      continue;
    }

    // Emit system messages (e.g. compact_boundary) as visible markers
    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      result.push({
        role: "system",
        type: "system",
        content: msg.content || "Conversation compacted",
        subtype: "compact_boundary",
        timestamp: msg.timestamp,
      });
      continue;
    }

    // Skip other system messages (e.g. turn_duration) that aren't user-facing
    if (msg.type === "system") continue;

    const role: "user" | "assistant" = msg.message?.role || msg.type;
    const content = msg.message?.content || msg.content;
    const timestamp = msg.timestamp;
    const teamName = msg.teamName;
    if (!content) continue;

    // The model's canned acknowledgment of a nudge we just hid. Anything else
    // it produced — including a genuine continuation — falls through and is
    // rendered normally.
    if (afterMetaPrompt) {
      afterMetaPrompt = false;
      if (role === "assistant" && isTextOnlySaying(content, META_PROMPT_ACK)) continue;
    }

    // An interruption is a fact about the run, not something the user said.
    // Rendered as a boundary marker (same treatment as compact/clear) instead
    // of a user bubble complete with copy and fork-from-here affordances.
    if (role === "user" && INTERRUPT_MARKERS.has(contentText(content).trim())) {
      result.push({
        role: "system",
        type: "system",
        content: "Interrupted by user",
        subtype: "interrupted",
        timestamp,
      });
      continue;
    }

    // Shape 2: the same notice arriving as a prompt rather than an attachment,
    // which is how the CLI flushes the queue on resume. Rendering it as-is
    // would show the user a block of XML they never typed.
    if (role === "user") {
      const notification = parseTaskNotification(contentText(content));
      if (notification) {
        pushTaskNotification(notification, timestamp);
        continue;
      }
    }

    // Extract per-entry metadata (shared across all content blocks from this JSONL line)
    const model = msg.message?.model;
    const gitBranch = msg.gitBranch;
    const rawUsage = msg.message?.usage;
    const usage = rawUsage
      ? {
          input_tokens: rawUsage.input_tokens,
          output_tokens: rawUsage.output_tokens,
          cache_creation_input_tokens: rawUsage.cache_creation_input_tokens,
          cache_read_input_tokens: rawUsage.cache_read_input_tokens,
        }
      : undefined;
    const serviceTier = rawUsage?.service_tier;

    // Debug / metrics fields
    const stopReason = msg.message?.stop_reason ?? undefined;
    const speed = rawUsage?.speed ?? undefined;
    const inferenceGeo = rawUsage?.inference_geo && rawUsage.inference_geo !== "not_available" ? rawUsage.inference_geo : undefined;
    const requestId = msg.requestId ?? undefined;
    const rawServerToolUse = rawUsage?.server_tool_use;
    const serverToolUse = rawServerToolUse
      ? { webSearchRequests: rawServerToolUse.web_search_requests, webFetchRequests: rawServerToolUse.web_fetch_requests }
      : undefined;
    const rawCacheCreation = rawUsage?.cache_creation;
    const cacheCreation = rawCacheCreation
      ? { ephemeral5m: rawCacheCreation.ephemeral_5m_input_tokens, ephemeral1h: rawCacheCreation.ephemeral_1h_input_tokens }
      : undefined;

    const meta = {
      ...(model && { model }),
      ...(gitBranch && { gitBranch }),
      ...(usage && { usage }),
      ...(serviceTier && { serviceTier }),
      ...(stopReason !== undefined && { stopReason }),
      ...(speed && { speed }),
      ...(inferenceGeo && { inferenceGeo }),
      ...(requestId && { requestId }),
      ...(serverToolUse && { serverToolUse }),
      ...(cacheCreation && { cacheCreation }),
    };

    if (typeof content === "string") {
      result.push({ role, type: "text", content, timestamp, ...(teamName && { teamName }), ...meta });
      continue;
    }

    if (!Array.isArray(content)) continue;

    // Collect image IDs from this JSONL entry's content blocks.
    // Images are stored to disk (with SHA256 dedup) and the IDs are
    // attached to the text message from the same entry.
    const entryImageIds: string[] = [];

    for (const block of content) {
      switch (block.type) {
        case "text":
          if (block.text) result.push({ role, type: "text", content: block.text, timestamp, ...(teamName && { teamName }), ...meta });
          break;
        case "image":
          if (block.source?.type === "base64" && block.source.data && block.source.media_type) {
            const imageId = storeBase64Image(block.source.data, block.source.media_type);
            if (imageId) entryImageIds.push(imageId);
          }
          break;
        case "thinking":
          // Extended-thinking blocks from Anthropic come in two shapes:
          //   1. plaintext  — `{ thinking: "actual reasoning", signature: "..." }` (rare;
          //      only seen in subagent compaction traces).
          //   2. encrypted — `{ thinking: "", signature: "..." }`. The reasoning content
          //      is not transmitted to clients; the signature is just an authenticity
          //      proof for multi-turn echo-back. We can't decrypt it.
          // We pass both through. The frontend renders an `🔒 Thinking (encrypted)`
          // placeholder for the empty case so users at least see the model thought
          // about something, instead of an expandable bubble that hides nothing.
          result.push({ role: "assistant", type: "thinking", content: block.thinking || "", timestamp, ...meta });
          break;
        case "tool_use":
          result.push({
            role: "assistant",
            type: "tool_use",
            content: JSON.stringify(block.input),
            toolName: block.name,
            toolUseId: block.id,
            timestamp,
            ...meta,
          });
          break;
        case "tool_result": {
          const { content: resultContent, imageIds } = extractToolResultContent(block);
          // A Bash call made with `run_in_background` returns a handle, not an
          // outcome. The CLI records the task's id beside the result, so the
          // launching end of a background task is identifiable structurally —
          // the id is what the completion marker is later paired against.
          const backgroundTaskId = typeof msg.toolUseResult?.backgroundTaskId === "string" ? msg.toolUseResult.backgroundTaskId : undefined;
          result.push({
            role: "assistant",
            type: "tool_result",
            content: resultContent,
            toolName: block.tool_use_id,
            toolUseId: block.tool_use_id,
            timestamp,
            ...(imageIds.length > 0 && { imageIds }),
            ...(backgroundTaskId && { backgroundTaskId }),
            ...meta,
          });
          break;
        }
      }
    }

    // Attach image IDs to the last text message from this entry
    if (entryImageIds.length > 0) {
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i].type === "text" && result[i].timestamp === timestamp) {
          result[i].imageIds = entryImageIds;
          break;
        }
      }
    }
  }

  // Compute inter-message timing deltas and throughput
  let prevTimestamp: number | null = null;
  for (const m of result) {
    if (!m.timestamp) continue;
    const ts = new Date(m.timestamp).getTime();
    if (isNaN(ts)) continue;
    if (prevTimestamp !== null) {
      m.deltaMs = ts - prevTimestamp;
      if (m.usage?.output_tokens && m.usage.output_tokens > 0 && m.deltaMs > 0) {
        m.msPerOutputToken = Math.round((m.deltaMs / m.usage.output_tokens) * 100) / 100;
      }
    }
    prevTimestamp = ts;
  }

  return result;
}

/**
 * Parse subagent JSONL messages and stamp them with a teamName for display.
 * Reuses the existing parseMessages() function, then adds teamName to every result.
 */
export function parseSubagentMessages(rawMessages: any[], teamName: string): ParsedMessage[] {
  const parsed = parseMessages(rawMessages);
  return parsed.map((msg) => ({ ...msg, teamName }));
}
