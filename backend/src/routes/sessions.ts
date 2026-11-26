import { Router } from "express";
import { sessionRegistry } from "../services/session-registry.js";
import { getServerBuildId } from "../services/build-identity.js";
import { listAwaitingChatIds } from "../services/pending-requests.js";
import { ancestorChatIds } from "../services/chat-lineage.js";
export const sessionsRouter = Router();

/**
 * GET /api/sessions/poll — Lightweight polling endpoint for session activity.
 *
 * Accepts optional query params:
 *   - v:  client's last-known session version
 *   - mv: client's last-known metadata version
 *   - b:  client's last-known daemon build id
 *
 * Returns:
 *   - version / metadataVersion always (so client can track)
 *   - sessions included only when version differs from client's `v`
 *   - awaitingInput (chat ids with a prompt or open approval waiting on the
 *     human) and awaitingBelow (their ancestors) alongside sessions, under
 *     the same version check
 *   - activeSummons included only when metadataVersion differs from client's `mv`
 *   - build included only when the daemon's build id differs from client's `b`
 *
 * When nothing has changed, the response is ~40 bytes of JSON.
 *
 * ## Why the build id rides along here
 *
 * A tab keeps its JavaScript across a `callboard restart`; nothing currently
 * tells it the daemon underneath changed. This route is the cheapest carrier
 * for that signal — the frontend already calls it every second — and a build id
 * on an existing request costs nothing next to a second poll.
 *
 * **Wire-compatibility.** `build` is a new *optional field*, not a new enum
 * value, which is the free side of the asymmetry documented at the top of
 * `shared/types/stream.ts`: an old client ignores a key it does not know, so no
 * `CLIENT_CAPS` gate is needed. (A new `StreamEvent.type` would have needed
 * one — an old client hits its `switch` default and drops the event whole.)
 * The reverse direction is covered too: `b` is optional, so a new daemon that
 * never receives it simply sends `build` on every poll, and an old daemon that
 * never sends `build` leaves a new client with no baseline, which the client
 * reads as "no information" rather than as a mismatch.
 *
 * **Only on change**, exactly as `sessions` and `activeSummons` work. The
 * client echoes back what it last saw and the daemon stays silent while they
 * agree, so the steady-state response keeps its ~40 bytes: `build` appears on
 * the first poll of a page load and then again only if the daemon moves.
 *
 * ## `awaitingInput`
 *
 * The ids (same keys as `sessions`) of chats blocked on the human: a tool
 * permission prompt, a question, a plan review, or an open computer-control
 * approval. The sidebar paints their dot — and every ancestor's — yellow
 * instead of green. Another optional field, so no capability gate: an old
 * client ignores it, and a new client facing an old daemon reads its absence
 * as "nobody is waiting". It is sent with `sessions` because the session
 * version is bumped whenever the pending-request set changes
 * (`pending-requests.ts`), so the two never disagree about freshness.
 *
 * `awaitingBelow` is every ancestor of those chats (`ancestorChatIds`), so an
 * ancestor row turns yellow even when the waiting chat is one the list never
 * loads — a `triggered` job or agent chat is filtered out of the sidebar, and
 * a collapsed card has no fetched tree to read. Only the server can walk that
 * lineage. Optional for the same reasons; computed once per session version
 * (the walk reads chat files), not once per poll.
 */
let awaitingCache: { version: number; awaitingInput: string[]; awaitingBelow: string[] } | undefined;

function awaitingSnapshot(version: number) {
  if (awaitingCache?.version === version) return awaitingCache;
  const awaitingInput = listAwaitingChatIds();
  const below = new Set<string>();
  for (const id of awaitingInput) {
    try {
      for (const ancestor of ancestorChatIds(id)) below.add(ancestor);
    } catch {
      // A chat record that cannot be read has no lineage to report; the chat's
      // own id is still in awaitingInput.
    }
  }
  awaitingCache = { version, awaitingInput, awaitingBelow: [...below] };
  return awaitingCache;
}

sessionsRouter.get("/poll", (_req, res) => {
  // #swagger.tags = ['Sessions']
  // #swagger.summary = 'Poll for session activity changes'
  // #swagger.description = 'Lightweight polling endpoint. Returns current version counters and optionally sessions/summons when they have changed since the client last polled.'
  /* #swagger.parameters['v'] = { in: 'query', required: false, type: 'integer', description: 'Client last-known session version' } */
  /* #swagger.parameters['mv'] = { in: 'query', required: false, type: 'integer', description: 'Client last-known metadata version' } */
  /* #swagger.parameters['b'] = { in: 'query', required: false, type: 'string', description: "Client last-known daemon build id. Omit it, or send one that no longer matches, and the response carries a build field. The client uses a change in that value to offer a reload - its bundle is from before the daemon moved. The literal string unknown means this daemon has no built frontend to identify. NOTE for hand-written callers: a build id contains a + character, which decodes as a space in a query string. URLSearchParams escapes it for you; curl does not, so use --data-urlencode or the echo will never match." } */
  /* #swagger.responses[200] = { description: "Poll result with version counters and optional sessions/summons/build payloads" } */
  const clientVersion = _req.query.v !== undefined ? Number(_req.query.v) : undefined;
  const clientMetaVersion = _req.query.mv !== undefined ? Number(_req.query.mv) : undefined;
  const clientBuild = typeof _req.query.b === "string" ? _req.query.b : undefined;

  const result: Record<string, unknown> = {
    version: sessionRegistry.version,
    metadataVersion: sessionRegistry.metadataVersion,
  };

  // Include the build id only when the client does not already have this one.
  const buildId = getServerBuildId();
  if (clientBuild !== buildId) {
    result.build = buildId;
  }

  // Include sessions only when version changed (or first poll)
  if (clientVersion === undefined || clientVersion !== sessionRegistry.version) {
    result.sessions = sessionRegistry.getAll();
    const awaiting = awaitingSnapshot(sessionRegistry.version);
    result.awaitingInput = awaiting.awaitingInput;
    result.awaitingBelow = awaiting.awaitingBelow;
  }

  // Include active summons only when metadata version changed (or first poll)
  if (clientMetaVersion === undefined || clientMetaVersion !== sessionRegistry.metadataVersion) {
    const summons: Record<string, unknown> = {};
    for (const [chatId, info] of sessionRegistry.activeSummons) {
      summons[chatId] = info;
    }
    result.activeSummons = summons;
  }

  res.json(result);
});

/**
 * GET /api/sessions/active — REST snapshot of all active sessions.
 *
 * Returns the same data as the initial poll. Useful for debugging
 * or as a fallback when polling isn't appropriate.
 */
sessionsRouter.get("/active", (_req, res) => {
  // #swagger.tags = ['Sessions']
  // #swagger.summary = 'Get all active sessions'
  // #swagger.description = 'Returns a snapshot of all currently active sessions with their type and start time.'
  /* #swagger.responses[200] = { description: "Map of chatId to session info" } */
  res.json(sessionRegistry.getAll());
});
