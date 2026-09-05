/**
 * Self-update API — "may I", "do it", and "let me watch".
 *
 * Its own router rather than more fields on `/api/system-info`, for the reason
 * `routes/engines.ts` gives about the same choice: system-info is polled by
 * several pages and read by older browser bundles, while the answer here is
 * **per client** — the same daemon says yes to a browser on the LAN and no to
 * that browser reaching it through the tunnel a minute later. Caching it beside
 * anything would hand one client the other's verdict.
 *
 * Auth is inherited: `app.use("/api", requireAuth)` runs before this router is
 * mounted, like every other route. On top of that every endpoint here is gated
 * on `isDirectLocalClient` — the same gate as engine installs, and for a
 * stronger reason: this one restarts the daemon, which calls `stopWebTunnel()`
 * and therefore severs a remote client's own connection, coming back (for a
 * quick tunnel) on a different URL. A tunnelled user must never see this button.
 *
 * @see backend/src/services/self-update.ts — every gate, and why it is there
 */
import { Router } from "express";
import type { Request } from "express";
import type { SelfUpdateCapability } from "shared/types/index.js";
import {
  activeSelfUpdateId,
  describeRestartPending,
  getSelfUpdateCapability,
  getSelfUpdateRun,
  isSelfUpdateRunDone,
  resolveInstallSource,
  selfPackage,
  selfUpdateCommand,
  selfUpdateRunEvents,
  startSelfUpdate,
  subscribeToSelfUpdateRun,
} from "../services/self-update.js";
import { getClientKey, isDirectLocalClient } from "../utils/client-ip.js";
import { createLogger } from "../utils/logger.js";
import { sendSSE, startSSEHeartbeat, writeSSEHeaders } from "../utils/sse.js";

const log = createLogger("self-update-route");

export const selfUpdateRouter = Router();

/** The package name to fall back on when this daemon cannot read its own manifest — for the copy block, which must never be empty. */
const FALLBACK_PACKAGE = "@wolpertingerlabs/callboard";

/**
 * How long the response stays open after `update_restarting` before the server
 * closes it itself.
 *
 * Sized by what can still legitimately arrive: `update_restart_failed`, which
 * comes from either a synchronous `spawn` throw or an `error` event on the
 * child, both of which land within milliseconds of the frame that precedes them.
 * Fifteen seconds is far past that and comfortably past the ordinary case too —
 * the helper's Node boot plus `cmdStop`'s SIGTERM is one to two seconds, and the
 * socket dies with the process long before this fires.
 *
 * So this only ever fires when the restart did not happen and did not report
 * itself either. Closing is the whole action: the client is already in its
 * `restarting` phase, where a stream ending is the *expected* shape of success,
 * and it moves straight to polling for the daemon to come back. There is no
 * frame to invent, and inventing one would be a claim about a restart nothing
 * here has observed.
 */
export const RESTART_STREAM_GRACE_MS = 15_000;

/**
 * This request's capability, evaluated per request and never cached.
 *
 * The same function `POST /` gates on, which is what keeps the promise holding
 * in both directions: a client that can see the button can press it, and a
 * client that cannot see one has been told why in a sentence rendered under the
 * command it can still copy.
 *
 * Never throws. A preflight that cannot answer is a refusal.
 */
async function capabilityFor(req: Request): Promise<SelfUpdateCapability> {
  try {
    return await getSelfUpdateCapability({ local: isDirectLocalClient(req) });
  } catch (err) {
    log.warn(`self-update preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      oneClick: false,
      code: "npm-unresolvable",
      refusal: "Callboard could not check whether it is able to update itself on this machine, so it will not try. Copy the command into a terminal instead.",
    };
  }
}

/**
 * `GET /api/self-update` — may this client update Callboard, and what would run?
 *
 * Read by Settings → About when it has already decided a newer version exists,
 * or when this daemon reports a restart pending. It is a GET with a side effect
 * of at most one cached `npm root -g` spawn, so it is not on any polling path —
 * the banner asks once, when it renders.
 *
 * Two versions come back, and they are two different questions.
 * {@link SelfUpdateStatusResponse.version} is what this process is *executing*
 * — the manifest as read at boot — and `installedVersion` is what is in the
 * package directory right now. They differ for as long as new files are on disk
 * and this daemon has not restarted into them, which includes the case a daemon
 * cannot otherwise detect at all: a *second* Callboard sharing one global
 * install, upgraded by its sibling without being asked and without anything
 * restarting it.
 */
selfUpdateRouter.get("/", async (req, res) => {
  // #swagger.tags = ['System']
  // #swagger.summary = 'Can Callboard install its own update here, and what would it run?'
  // #swagger.description = 'Reports whether this client may ask the daemon to run `npm install -g` on itself and restart, plus the version it is running, the version currently on disk, whether a restart is pending because those differ, and the equivalent shell command. Refused - with a one-line reason for the UI to render next to the copy-and-paste command - for clients outside the LAN, when allowEngineInstalls is off, on Windows, when npm global prefix is missing or not writable, and when the daemon is running from a git checkout rather than the global install npm would replace. A daemon with no PID file naming it is NOT refused: it can install, and the capability declares restart: unavailable so the button says up front that the restart is the user own. The command is present in every response, including every refusal.'
  /* #swagger.responses[200] = { description: 'Capability, running and installed versions, and the command' } */
  const pkg = selfPackage();
  const capability = await capabilityFor(req);
  const packageName = pkg?.name ?? FALLBACK_PACKAGE;
  const activeUpdateId = activeSelfUpdateId();
  const { pending, installedVersion } = describeRestartPending();
  return res.json({
    capability,
    version: pkg?.version ?? "unknown",
    ...(installedVersion ? { installedVersion } : {}),
    ...(pending ? { restartPending: true } : {}),
    package: packageName,
    command: selfUpdateCommand(packageName),
    ...(activeUpdateId ? { activeUpdateId } : {}),
  });
});

/**
 * `POST /api/self-update` — run it here.
 *
 * Nothing from the request reaches a command line: the argv is assembled in the
 * service from the package name in this daemon's own `package.json`, and there
 * is no body, no parameter and no shell. The one thing this handler contributes
 * is the pairing — the capability it gates on and the paths it hands to the
 * service are the ones resolved for *this* request, so the check and the spawn
 * cannot be looking at different machines.
 */
selfUpdateRouter.post("/", async (req, res) => {
  // #swagger.tags = ['System']
  // #swagger.summary = 'Install the latest Callboard on this machine and restart the daemon'
  // #swagger.description = 'Runs `npm install -g <this package>` on the machine hosting Callboard and returns an updateId to stream. The package name comes from the daemon own package.json; nothing from the request reaches the command line and no shell is used. A zero exit is followed by reading the version npm actually wrote, and only then by a restart - which is skipped when the version did not move and refused when a chat is streaming or a job run is mid-step, because a restart kills in-flight agent turns. After update_restarting the daemon dies and the stream simply stops, so the client polls for it to come back.'
  /* #swagger.responses[200] = { description: 'Update started' } */
  /* #swagger.responses[403] = { description: 'Refused: not a local client, or the capability is switched off' } */
  /* #swagger.responses[409] = { description: 'Refused: an update or an engine install is already running' } */
  /* #swagger.responses[422] = { description: 'Refused: npm preflight failed, the daemon is not the global install, or there is no PID file to restart' } */
  /* #swagger.responses[429] = { description: 'Refused: an update finished moments ago and the endpoint is cooling down' } */
  /* #swagger.responses[500] = { description: 'Refused: the assembled npm argv failed the service own assertions, so nothing was spawned' } */
  const capability = await capabilityFor(req);
  const pkg = selfPackage();
  // The capability is what decides; these are only the values it already
  // resolved, re-read so the service is handed data rather than asked to
  // recompute a second, possibly different, answer. A capability that passed
  // guarantees both are present — the guard is for the ordering, not the odds.
  const source = pkg ? await resolveInstallSource(pkg.name) : null;

  if (!capability.oneClick || !pkg || !source?.globalPackageRoot) {
    const refusal = capability.refusal ?? "Callboard could not confirm it is the copy an install would replace, so it will not run one.";
    const code = capability.code ?? "not-global-install";
    // `error` and `refusal` carry the same sentence on purpose: `error` is what
    // the frontend's generic `assertOk` surfaces, and `refusal` is what the
    // banner renders under the copy block.
    return res.status(code === "not-local" || code === "disabled" ? 403 : 422).json({ error: refusal, refusal, code });
  }

  // No `fromVersion`: the version being replaced is the one this process is
  // running, which the service holds as a boot snapshot. Passing a freshly-read
  // one from here is what made a retry compare the post-install manifest against
  // itself and conclude there was nothing to restart into.
  const result = startSelfUpdate({
    capability,
    source: { packageName: pkg.name, globalPackageRoot: source.globalPackageRoot },
    clientKey: getClientKey(req),
  });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.refusal, refusal: result.refusal, code: result.code });
  }

  return res.json({ updateId: result.updateId, package: result.package, command: result.command, fromVersion: result.fromVersion });
});

/**
 * `GET /api/self-update/runs/:updateId/stream` — npm's output, live, and the
 * decision that follows it.
 *
 * Replays everything the run has emitted so far and then follows it, so a client
 * that connects a beat after the POST (or reconnects after a reload) sees the
 * whole transcript rather than the tail.
 *
 * **This stream cannot deliver the outcome of a successful update**, and that is
 * by construction rather than by omission: the last frame a *successful* update
 * produces is `update_restarting`, after which the process serving this response
 * is stopped. A client that sees that frame stops reading and starts polling for
 * the daemon to come back. Every other terminal frame — a failed install, a
 * refused restart — is delivered normally, because in those cases the daemon is
 * still here.
 *
 * Which is exactly why `update_restarting` does **not** end the response. It is
 * the last frame of the path that works, not the last frame there is: the spawn
 * it announces can still fail asynchronously, and the frame that says so —
 * `update_restart_failed` — arrives a moment later. Ending here to save a socket
 * the dying process is about to close anyway made that frame undeliverable, and
 * left the one case where the daemon is alive and needs to explain itself
 * looking identical to the case where it is gone. The client then waited out its
 * 90-second poll and advised a downgrade of a daemon that had never restarted.
 *
 * It does not end the response, and it does not leave it open forever either.
 * On the ordinary path the process dies and takes the socket with it, which is
 * why there was no server-side bound at all — but that is a bound provided by
 * something *not happening here*, and a restart that hangs (the helper spawned
 * and never signalled, `cmdStop` waiting out its own timeout) leaves the
 * response open on a heartbeat with a `RunLog` listener attached to it. A
 * browser is fine; a `curl` or a script is a listener held for the lifetime of
 * the daemon. So {@link RESTART_STREAM_GRACE_MS} after `update_restarting` the
 * response closes — reachable only when this process is still alive, which is
 * exactly the case where it can afford to say something.
 */
selfUpdateRouter.get("/runs/:updateId/stream", (req, res) => {
  // #swagger.tags = ['System']
  // #swagger.summary = 'Stream one self-update: npm output, the installed version, and the restart decision'
  // #swagger.description = 'Server-sent events for an update started by POST /api/self-update. Emits update_started, then update_output per line of stdout/stderr, then update_exit. A zero exit is followed by update_verified carrying the version read from the newly installed package and what will happen to the restart (pending, skipped when the version did not move, or refused when work is in flight). When a restart is pending, update_restarting is emitted as the helper is spawned and the connection then dies with the daemon - that is the expected shape of success, and the client polls from there. The response is deliberately left open at that point so that update_restart_failed, which is only reachable when the spawn failed and the daemon is therefore still alive, can still be delivered. Replays the transcript from the start on connect. LAN clients only.'
  /* #swagger.responses[200] = { description: 'SSE stream' } */
  /* #swagger.responses[403] = { description: 'Not a local client' } */
  /* #swagger.responses[404] = { description: 'No such update, or it has aged out' } */
  if (!isDirectLocalClient(req)) {
    return res.status(403).json({
      error: "Update output is only available to clients on the local network.",
      refusal: "Update output is only available to clients on the local network.",
      code: "not-local",
    });
  }

  const run = getSelfUpdateRun(String(req.params.updateId ?? ""));
  if (!run) {
    return res.status(404).json({
      error: "No such update — it finished a while ago, or the daemon has restarted since.",
      // The likeliest reason a client asks for an update the daemon has never
      // heard of is that the update *worked*: this is a different process now,
      // and it has no memory of the run its predecessor was serving.
      refusal: "Callboard is no longer holding that update's output. If Callboard restarted, this is the new daemon — check the version on this page.",
      code: "run-not-found",
    });
  }

  writeSSEHeaders(res);
  const stopHeartbeat = startSSEHeartbeat(res);

  // Declared before `finish` because `finish` may run before anything has been
  // subscribed — a run that is already done replays and closes immediately.
  let unsubscribe: (() => void) | null = null;
  let closed = false;
  let restartGrace: NodeJS.Timeout | null = null;
  const finish = () => {
    if (closed) return;
    closed = true;
    if (restartGrace) clearTimeout(restartGrace);
    stopHeartbeat();
    unsubscribe?.();
    res.end();
  };

  // See {@link RESTART_STREAM_GRACE_MS}. Armed once, on the first
  // `update_restarting` — whether it arrives live or in the replay, because a
  // client attaching to a run that is already restarting needs the same bound.
  // `unref()` so a pending close never holds the process open; nothing here is
  // worth delaying a shutdown for.
  const armRestartGrace = () => {
    if (restartGrace || closed) return;
    restartGrace = setTimeout(() => {
      log.warn(`self-update stream ${run.updateId}: no restart ${RESTART_STREAM_GRACE_MS}ms after update_restarting, and this daemon is still here — closing the stream`);
      finish();
    }, RESTART_STREAM_GRACE_MS);
    restartGrace.unref?.();
  };

  // Replay, then subscribe — synchronously, with nothing awaited in between, so
  // an event emitted by the child process cannot slip through the gap.
  const replayed = selfUpdateRunEvents(run);
  for (const event of replayed) sendSSE(res, { ...event });
  if (isSelfUpdateRunDone(run) && isTerminal(replayed)) {
    finish();
    return;
  }
  if (replayed.some((e) => e.type === "update_restarting")) armRestartGrace();

  unsubscribe = subscribeToSelfUpdateRun(run, (event) => {
    if (closed) return;
    sendSSE(res, { ...event });
    if (isTerminalEvent(event)) finish();
    else if (event.type === "update_restarting") armRestartGrace();
  });

  req.on("close", finish);
});

/**
 * Is this the last frame the client will get?
 *
 * `run.done` is set when *npm* finishes, which is several frames before the run
 * is over: the verdict, the restart decision and the restarting notice all
 * follow it. So "done" alone must not close the stream — the terminal frame is
 * the one that says what happened.
 *
 * `update_restarting` is not one of them, despite being the last frame of a
 * successful update. It is a statement about a spawn that has *just been
 * attempted*, and the failure of that spawn is reported on this same
 * connection. Keeping the response open costs nothing in the ordinary case —
 * the process is about to die and take the socket with it — and is the only way
 * `update_restart_failed` ever reaches anybody.
 */
function isTerminalEvent(event: { type: string; ok?: boolean; restart?: string }): boolean {
  if (event.type === "update_exit") return event.ok === false;
  if (event.type === "update_verified") return event.restart !== "pending";
  return event.type === "update_restart_failed";
}

function isTerminal(events: Array<{ type: string; ok?: boolean; restart?: string }>): boolean {
  return events.some(isTerminalEvent);
}
