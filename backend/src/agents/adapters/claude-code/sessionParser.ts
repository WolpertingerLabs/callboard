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

function extractToolResultContent(block: any): string {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((c: any) => {
        if (typeof c === "string") return c;
        if (c.type === "text") return c.text;
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(block.content);
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
    if (msg.type === "summary" || msg.type === "queue-operation") continue;

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
        case "tool_result":
          result.push({
            role: "assistant",
            type: "tool_result",
            content: extractToolResultContent(block),
            toolName: block.tool_use_id,
            toolUseId: block.tool_use_id,
            timestamp,
            ...meta,
          });
          break;
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
