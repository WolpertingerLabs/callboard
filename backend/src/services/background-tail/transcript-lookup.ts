/**
 * Find one Bash tool call in a chat's Claude Code transcript: the command it
 * ran, the directory it ran in, and the launch result.
 *
 * The full session parser reads and converts every line, which is far too
 * much to do on each poll of a tail. This scans the raw JSONL and parses only
 * the lines that mention the tool-use id. Transcripts are append-only, so the
 * scan is incremental: each (chat, tool call) remembers how far into each log
 * it has read, and a later poll reads only the bytes added since — a
 * foreground launch still waiting for its tool_result costs a stat and a few
 * new lines, not a re-read of a multi-megabyte file. A log that shrinks
 * (rewritten) is rescanned from the start.
 *
 * Logs are searched oldest session first. A transcript carried into a new
 * session (fork, model switch, resume) repeats earlier lines under the new
 * session's id; the first log to contain the call is the one it was launched
 * in, which is the session its engine output file is filed under.
 *
 * Main session logs only; background calls made inside a subagent's own
 * transcript are not looked up yet.
 */
import { open } from "fs/promises";
import { parseChatMetadata } from "../../utils/chat-metadata.js";
import { findSessionLogPath } from "../../utils/session-log.js";

export interface ToolCallInfo {
  /** Session id on the tool_use line. */
  sessionId: string;
  /** Every session id of the chat, oldest first — the engine file may be filed under any of them. */
  sessionIds: string[];
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

interface Use {
  sessionId: string;
  cwd: string | null;
  toolName: string;
  command: string;
  path: string;
}
interface Result {
  text: string;
  taskId?: string;
}
interface Entry {
  at: number;
  /** Bytes of each log already scanned (always up to a line boundary). */
  offsets: Map<string, number>;
  use?: Use;
  result?: Result;
}

const CACHE_MAX = 256;
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, Entry>();

/** Test hook. */
export function clearToolCallCache(): void {
  cache.clear();
}

function cacheGet(key: string): Entry | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  if (Date.now() - hit.at > CACHE_TTL_MS) return null;
  cache.set(key, hit); // refresh recency
  return hit;
}

function cacheSet(key: string, entry: Entry): void {
  entry.at = Date.now();
  cache.delete(key);
  cache.set(key, entry);
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

/** Session ids to search, oldest first. */
function sessionIdsOf(chat: ChatForLookup): string[] {
  const meta = parseChatMetadata(chat.metadata);
  const ids: string[] = Array.isArray(meta.session_ids) ? meta.session_ids.filter((s: unknown): s is string => typeof s === "string") : [];
  if (chat.session_id && !ids.includes(chat.session_id)) ids.push(chat.session_id);
  return ids;
}

/** Record the tool_use / tool_result lines for `toolUseId` found in `text` (whole lines only). */
function scanLines(text: string, toolUseId: string, path: string, entry: Entry): void {
  if (!text.includes(toolUseId)) return;
  for (const line of text.split("\n")) {
    if (!line.includes(toolUseId)) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw JSONL entry
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = row?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (!entry.use && block.type === "tool_use" && block.id === toolUseId) {
        entry.use = {
          sessionId: typeof row.sessionId === "string" ? row.sessionId : "",
          cwd: typeof row.cwd === "string" ? row.cwd : null,
          toolName: typeof block.name === "string" ? block.name : "",
          command: typeof block.input?.command === "string" ? block.input.command : "",
          path,
        };
      } else if (!entry.result && block.type === "tool_result" && block.tool_use_id === toolUseId) {
        const taskId = row.toolUseResult?.backgroundTaskId;
        entry.result = { text: resultTextOf(block.content), ...(typeof taskId === "string" && { taskId }) };
      }
    }
    if (entry.use && entry.result) return;
  }
}

/** Scan whatever `path` gained since the last visit, up to its last complete line. */
async function scanNew(path: string, toolUseId: string, entry: Entry): Promise<void> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return;
  }
  try {
    const { size } = await fh.stat();
    let offset = entry.offsets.get(path) ?? 0;
    if (size < offset) {
      // Rewritten: start over, and forget what came from this file.
      offset = 0;
      if (entry.use?.path === path) {
        entry.use = undefined;
        entry.result = undefined;
      }
    }
    if (size === offset) return;
    const buf = Buffer.alloc(size - offset);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, offset + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    const end = buf.lastIndexOf(0x0a, got - 1);
    if (end < 0) return; // no complete line yet
    scanLines(buf.subarray(0, end + 1).toString("utf8"), toolUseId, path, entry);
    entry.offsets.set(path, offset + end + 1);
  } catch {
    // Unreadable this time; try again on the next poll.
  } finally {
    await fh.close().catch(() => {});
  }
}

export async function findToolCall(chat: ChatForLookup, toolUseId: string): Promise<ToolCallInfo | null> {
  const key = `${chat.id}\0${toolUseId}`;
  const entry = cacheGet(key) ?? { at: 0, offsets: new Map<string, number>() };
  const sessionIds = sessionIdsOf(chat);

  if (!(entry.use && entry.result)) {
    if (entry.use) {
      // Found the launch; only its own log can still gain the result.
      await scanNew(entry.use.path, toolUseId, entry);
    } else {
      const paths: string[] = [];
      for (const sid of sessionIds) {
        const p = (sid === chat.session_id && chat.session_log_path) || findSessionLogPath(sid, chat.metadata);
        if (p && !paths.includes(p)) paths.push(p);
      }
      for (const p of paths) {
        await scanNew(p, toolUseId, entry);
        if (entry.use) {
          // The result may follow in a part of this log written later.
          break;
        }
      }
    }
    cacheSet(key, entry);
  }

  if (!entry.use) return null;
  const { sessionId, cwd, toolName, command } = entry.use;
  return {
    sessionId,
    cwd,
    toolName,
    command,
    sessionIds,
    resultText: entry.result?.text ?? null,
    ...(entry.result?.taskId && { taskId: entry.result.taskId }),
  };
}
