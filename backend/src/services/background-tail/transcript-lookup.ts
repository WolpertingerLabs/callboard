/**
 * Find one Bash tool call in a chat's Claude Code transcript: the command it
 * ran, the directory it ran in, and the launch result.
 *
 * The full session parser reads and converts every line, which is far too
 * much to do on each poll of a tail. This scans the raw JSONL, parses only
 * the lines that mention the tool-use id, and caches the answer once both the
 * tool_use and its tool_result have been seen — transcript lines are never
 * rewritten, so later polls only pay for stat-ing and reading the tail.
 *
 * Main session logs only; background calls made inside a subagent's own
 * transcript are not looked up yet.
 */
import { readFile } from "fs/promises";
import { parseChatMetadata } from "../../utils/chat-metadata.js";
import { findSessionLogPath } from "../../utils/session-log.js";

export interface ToolCallInfo {
  sessionId: string;
  /** Working directory recorded on the tool_use line. */
  cwd: string | null;
  toolName: string;
  command: string;
  /** Text of the tool_result, once written. */
  resultText: string | null;
  /** `toolUseResult.backgroundTaskId`, for a `run_in_background` launch. */
  taskId?: string;
}

export interface ChatForLookup {
  id: string;
  session_id?: string | null;
  metadata?: string | null;
  session_log_path?: string | null;
}

const CACHE_MAX = 256;
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; info: ToolCallInfo }>();

/** Test hook. */
export function clearToolCallCache(): void {
  cache.clear();
}

function cacheGet(key: string): ToolCallInfo | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Refresh recency.
  cache.delete(key);
  cache.set(key, hit);
  return hit.info;
}

function cacheSet(key: string, info: ToolCallInfo): void {
  cache.set(key, { at: Date.now(), info });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

function resultTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .join("\n");
  }
  return "";
}

/** Session ids to search, newest first. */
function sessionIdsOf(chat: ChatForLookup): string[] {
  const meta = parseChatMetadata(chat.metadata);
  const ids: string[] = Array.isArray(meta.session_ids) ? meta.session_ids.filter((s: unknown): s is string => typeof s === "string") : [];
  if (chat.session_id && !ids.includes(chat.session_id)) ids.push(chat.session_id);
  return ids.reverse();
}

interface Scan {
  use?: { sessionId: string; cwd: string | null; toolName: string; command: string };
  result?: { text: string; taskId?: string };
}

function scanLog(content: string, toolUseId: string): Scan {
  const scan: Scan = {};
  if (!content.includes(toolUseId)) return scan;
  for (const line of content.split("\n")) {
    if (!line.includes(toolUseId)) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw JSONL entry
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = entry?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (!scan.use && block.type === "tool_use" && block.id === toolUseId) {
        scan.use = {
          sessionId: typeof entry.sessionId === "string" ? entry.sessionId : "",
          cwd: typeof entry.cwd === "string" ? entry.cwd : null,
          toolName: typeof block.name === "string" ? block.name : "",
          command: typeof block.input?.command === "string" ? block.input.command : "",
        };
      } else if (!scan.result && block.type === "tool_result" && block.tool_use_id === toolUseId) {
        const taskId = entry.toolUseResult?.backgroundTaskId;
        scan.result = { text: resultTextOf(block.content), ...(typeof taskId === "string" && { taskId }) };
      }
    }
    if (scan.use && scan.result) break;
  }
  return scan;
}

export async function findToolCall(chat: ChatForLookup, toolUseId: string): Promise<ToolCallInfo | null> {
  const key = `${chat.id}\0${toolUseId}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const paths: string[] = [];
  for (const sid of sessionIdsOf(chat)) {
    const p = (sid === chat.session_id && chat.session_log_path) || findSessionLogPath(sid, chat.metadata);
    if (p && !paths.includes(p)) paths.push(p);
  }

  for (const p of paths) {
    let content: string;
    try {
      content = await readFile(p, "utf8");
    } catch {
      continue;
    }
    const scan = scanLog(content, toolUseId);
    if (!scan.use) continue;
    const info: ToolCallInfo = {
      ...scan.use,
      resultText: scan.result?.text ?? null,
      ...(scan.result?.taskId && { taskId: scan.result.taskId }),
    };
    if (scan.result) cacheSet(key, info);
    return info;
  }
  return null;
}
