/**
 * Background Bash output — `/api/chats/:id/background-tasks/:toolUseId/tail`.
 *
 * Polled by the tool bubble's output panel while it is open. The tool call
 * is looked up in the chat's own transcript and every file path comes from
 * there; the client chooses only a stream id. See
 * `services/background-tail/index.ts` for which files are read and why.
 *
 * Mounted on `/api/chats` with the full paths spelled out, like the other
 * chat-scoped routers, so swagger-autogen sees the real paths.
 */
import { Router } from "express";
import { findChat } from "../utils/chat-lookup.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { BadStreamError, getBackgroundTail, STREAM_ID } from "../services/background-tail/index.js";
import { clampLines } from "../services/background-tail/tail-reader.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("background-tasks-routes");

export const backgroundTasksRouter = Router();

const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;

backgroundTasksRouter.get("/:id/background-tasks/:toolUseId/tail", async (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Tail a background Bash call\'s output'
  // #swagger.description = 'The end of the output of a background Bash tool call: the engine\'s own output file for a run_in_background call, plus any files the command redirects to (`> log 2> err`, `tee`). Paths come from the chat\'s transcript, never from the request. Pass `since` (`<size>-<mtimeMs>` from the previous tail) to get `unchanged: true` without lines when the stream has not changed. Claude Code chats only.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID' } */
  /* #swagger.parameters['toolUseId'] = { in: 'path', required: true, type: 'string', description: 'Tool use id of the Bash call' } */
  /* #swagger.parameters['stream'] = { in: 'query', required: false, type: 'string', description: '"output" or "r0".."r7"; defaults to the most recently written stream' } */
  /* #swagger.parameters['lines'] = { in: 'query', required: false, type: 'integer', description: 'Lines to return, 1-500 (default 200)' } */
  /* #swagger.parameters['since'] = { in: 'query', required: false, type: 'string', description: '<size>-<mtimeMs> of the last tail seen for this stream' } */
  /* #swagger.responses[200] = { description: "BackgroundTailResponse" } */
  res.set("Cache-Control", "no-store");
  const { id, toolUseId } = req.params;
  if (!CHAT_ID.test(id)) return void res.status(400).json({ error: "Invalid chat id" });
  if (!TOOL_USE_ID.test(toolUseId)) return void res.status(400).json({ error: "Invalid tool use id" });

  const q = req.query;
  const stream = typeof q.stream === "string" && q.stream !== "" ? q.stream : undefined;
  if (q.stream !== undefined && (stream === undefined || !STREAM_ID.test(stream))) return void res.status(400).json({ error: "Invalid stream" });
  const since = typeof q.since === "string" ? q.since : undefined;
  const lines = clampLines(typeof q.lines === "string" ? q.lines : undefined);

  const chat = findChat(id, false);
  if (!chat) return void res.status(404).json({ error: "Not found" });
  if (chat._provider_resolution_error) return void res.status(409).json({ error: chat._provider_resolution_error });
  const provider = parseChatMetadata(chat.metadata).provider ?? "claude-code";
  if (provider !== "claude-code") return void res.status(404).json({ error: "unsupported_provider" });

  try {
    const result = await getBackgroundTail(chat, toolUseId, { stream, lines, since });
    if (!result) return void res.status(404).json({ error: "tool_call_not_found" });
    res.json(result);
  } catch (err) {
    if (err instanceof BadStreamError) return void res.status(400).json({ error: "Invalid stream" });
    log.error(`tail failed for ${id}/${toolUseId}: ${err}`);
    res.status(500).json({ error: "Failed to read background output" });
  }
});
