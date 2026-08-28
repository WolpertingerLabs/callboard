# Self-update: "Download latest & restart"

Turn the sentence Settings → About has printed for a year — *"Update available:
v1.0.0-alpha.52 → v1.0.0-alpha.53. Run: `npm install -g
@wolpertingerlabs/callboard`"* — into a button, on the machines where a button
can be honest, and leave the sentence exactly where it is on every other machine.

Status: built. This is the record of what it does and why, written alongside the
code rather than ahead of it.

## Why this is a sibling of engine installs, not a case of them

`plans/engine-availability-and-install.md` already shipped the hard parts of
"Callboard runs `npm install -g` for you": a preflight that predicts EACCES
instead of rendering it, a LAN-only client gate, a frozen argv with no shell, a
line-buffered transcript over SSE, and Decision 8 — *every refusal lands on a
copy-and-paste command that was never removed*. All of that is reused verbatim.

What is **not** reused is the route. Adding Callboard to
`INSTALLABLE_PACKAGES` and taking `POST /api/engines/callboard/install` would
have inherited two behaviours that are wrong for it:

| Engine install | Self-update |
|---|---|
| `oneClickRecipeFor(id)` selects from a static registry of *engines* | There is no id and no selection — the package is whatever this daemon's own `package.json` says it is |
| Verified by re-probing an **engine binary** and asking whether a chat could run on it | Verified by the daemon **going away and coming back**, which the process reporting on it cannot witness |
| A zero exit that produced no visible binary is a refusal | A zero exit that produced no *version change* is a no-op, and a restart would be pure cost |

So the shared parts moved down into `services/npm-global-install.ts` — preflight,
child-process discipline, replay buffer — and the two features sit on top of it
as peers. The refusal *sentences* stayed with each feature: "Callboard has not
changed anything about this engine" and "Callboard is still running v1.0.0 and
has not restarted" are claims about different things.

## The value that had to exist first: what version is this process running?

Three of this feature's bugs were one absence. **Nothing in Callboard meant "the
version this process is executing."** `npm install -g` replaces the package tree
*in place*, so every read of `<pkgRoot>/package.json` after npm exits describes
code on disk that is not running and will not run until the daemon restarts.
Both of the comparisons this feature is built on were reading that file fresh on
both sides:

- **The documented retry could never restart.** `changed = installedVersion !==
  fromVersion`, with `fromVersion` re-read per request. On a *second* press both
  sides read the same file — already overwritten by the first press — so they
  agreed, `changed` came out false, and the run reported `restart: "skipped"`
  with the words *"there is nothing to restart into"* after a thirty-second npm
  run, while the daemon carried on executing the old code. That second press is
  exactly the retry the deferred-restart branch tells every user to make. The
  only way out was `callboard restart` in a terminal, which is the thing this
  feature exists to remove.
- **The banner deleted itself.** `/api/system-info` reported the same fresh read
  as `version`, and Settings → About renders `<UpdateBanner>` behind
  `isNewerVersion(version, latestVersion)`. The instant npm exited, that went
  false and the banner unmounted — taking the verdict, the retry button and the
  entire reattach path with it, in precisely the window they were written for.
  The "Version" row also named a version nothing was running, and the restart
  poll (`probeDaemonVersion`, which reads this field) could be satisfied by the
  *old* daemon answering before the SIGTERM landed.

`utils/package-manifest.ts` reads the manifest **once, at module load**, and that
snapshot is the answer to "what is running". It is deliberately not refreshable:
a function that could re-read it would be a function someone could call after
npm. The per-call reader is still exported under a different name, because "what
did npm just write?" is a real question with a real caller —
`resolveRestartHelper`, reading the *new* package's `bin`.

Two consequences worth stating:

- `startSelfUpdate` has no `fromVersion` parameter any more. The version being
  replaced is not a caller's to state, and a parameter no caller can pass is a
  parameter no *test* can decouple from production either — which is how the old
  suite was structurally unable to catch the retry bug. Its `runUpdate()` passed
  `fromVersion: SELF_VERSION` while the global manifest said `9.9.9`, so the two
  sides were unequal by construction and every `changed` assertion passed for the
  wrong reason.
- `system-info`'s `version` keeps its documented meaning ("the version this
  daemon is") and gets an implementation that matches it, rather than being
  redefined or renamed. The genuinely new datum is what npm has left on disk, so
  that arrives as its own optional fields, `installedVersion` and
  `restartPending`. An old bundle reading `version` now gets a more correct
  answer to the question it was already asking, and nothing has to understand a
  redefinition — which is the direction `shared/types/stream.ts`'s rule points.

### Two daemons, one global install

A second Callboard can run from the same global install with a different
`CALLBOARD_DATA_DIR` and port. Every gate below is about *this* process, so both
pass independently — and when one updates, npm rewrites the tree under both. The
other is neither restarted nor told: it goes on serving the new `frontend/dist`
from old backend code indefinitely.

Callboard cannot fix that from inside one process. It has no handle on its
sibling — the PID file it would need names the other daemon and lives in the
other data directory — and inventing one would be a supervisor, not an update
button. What it *can* do, once a boot version exists, is notice:
`describeRestartPending()` compares the boot version against the manifest on disk
on every `GET /api/self-update` and on every `/api/system-info`, and the banner
renders a **"Restart pending"** headline naming both versions. Before this the
state was not merely unfixable but invisible — the sibling's About page read the
same rewritten manifest, reported the new version, and showed no banner at all,
so there was no UI path to the restart that would have fixed it.

The `NEW_BUNDLE_IS_LIVE` sentence every "installed, not restarted" verdict ends
with now says so too, because the daemon that just installed is the one that
knows an install happened.

## The gate that decides whether the button exists at all

`npm install -g @wolpertingerlabs/callboard` upgrades whatever lives under `npm
root -g`. That is **this** Callboard only when this Callboard was installed
globally. Started from a checkout — `npm run dev`, or `node
backend/dist/index.js` in a clone, which is how everyone working on Callboard
runs it — the install would succeed against a copy somewhere else, the restart
would reload the same unchanged source, and the observable result is a button
that does nothing.

Three conditions, all required, all checked per request:

1. **`<npm root -g>/<package>` resolves to this daemon's own package root**,
   symlinks resolved on both sides (a global prefix is very often reached
   through one — nvm, Homebrew, a moved `~/.npm-global`).
2. **That global entry is not itself a symlink.** Resolving symlinks is what
   makes condition 1 work on real prefixes, and it is also the one way a
   checkout can pass it: `npm link` makes `<npm root -g>/<package>` a link
   *into* the working tree, so both sides resolve to the same directory and the
   comparison says yes. Pressing the button would then delete the link, install
   a published package over it, and restart from a directory that is not the one
   the daemon reported running from — the checkout silently unlinked. So the
   entry is `lstat`ed, and a link is refused with a sentence that says which of
   those two things happened, rather than the "you are running from a checkout"
   one, which would be describing a comparison that passed.
Failing either of them, there is no button — and the refusal names the directory
Callboard is actually running from, because "no button" without that sentence is
indistinguishable from a bug.

### The PID file is a restart gate, not a capability gate

There used to be a third condition here: **`<DATA_DIR>/callboard.pid` names this
process**, checked rather than merely existing, because `callboard stop` SIGTERMs
whatever pid it reads and a stale or foreign file would aim the restart at
something else. That check is still made, and still made that way. What changed
is what it decides.

As a capability gate it refused the button to systemd, pm2, Docker and every
`callboard start --foreground` run — with a sentence that said, in as many words,
*"It can install the new version, but…"* and then offered no way to. That is a
capability withheld in the same breath as claiming it, to a population that is
not small. Callboard already has a first-class "installed, did not restart"
outcome, and a missing PID file is that situation **known in advance**, so it is
now a pre-declared restart disposition:

- `SelfUpdateCapability.restart === "unavailable"`, with a note beside the button
  naming the file it looked for;
- the button appears, labelled *"Download latest"* rather than *"Download latest
  & restart"*;
- the run lands on `update_verified` with `restart: "refused"`, carrying the same
  sentence the note carried — so the promise made up front is the one kept at the
  end.

It is re-checked in `finishInstalled` rather than trusted from the capability
object: a pid file can appear or vanish between the button rendering and npm
finishing, and a promise made before the install is worth nothing if the code
after it reaches `spawnRestartHelper` regardless.

`no-pid-file` is gone from `SelfUpdateRefusalCode` as a result — not pruned for
tidiness, but because nothing emits it any more.

## The restart

A process cannot restart itself, and a plain child of a dying parent is not
enough: the helper's entire job runs *after* this process is gone.

```
spawn(process.execPath, [<new>/bin/callboard.js, "restart", "--port", PORT], {
  detached: true, stdio: "ignore", env: process.env, cwd: <new>
}).unref()
```

- **`detached`** gives the helper its own process group, so the SIGTERM it is
  about to send — and the death that follows — does not reach it.
- **The helper comes from the *newly installed* global path**, resolved through
  that package's own `bin` field, not from this process's `__pkgRoot`: npm
  replaces that directory in place during the upgrade.
- **`--port` is forwarded when the daemon has one in its environment**, which is
  how `callboard start` launches it. Without it the CLI falls back to `.env`, and
  a daemon whose port lives only in an environment variable would come back on a
  different one — the browser would then poll for a server that is running
  perfectly well somewhere else.
- `callboard restart` is `cmdStop` (SIGTERM, wait, SIGKILL if it must) then
  `cmdStart` (spawn, health-check). Both already exist and are already what
  `POST /api/restart` uses.

The spawn is scheduled 500ms after the `update_verified` frame, so it flushes
before the socket dies with the process.

That spawn is also the one place a `child.on("error")` is load-bearing rather
than tidy. `spawn` throws synchronously only for a bad *argument*; every way the
OS refuses this — `EACCES`/`ENOENT` on the cwd, `EAGAIN`/`EMFILE` under fork
pressure — arrives later as an `error` event, and an unhandled one is rethrown,
caught by `installProcessGuards`, and answered with `process.exit(1)`. That is
the worst outcome the feature has: the daemon gone, no helper running to bring
it back, and nothing said to the client because the spawn had already been
reported as a success. The listener turns it into `update_restart_failed`.

## Work in flight stops the restart, not the install

`gracefulShutdown` aborts in-flight agent turns. So immediately before the helper
is spawned — not before the install, which harms nothing — Callboard asks:

- any **web** session in the registry (CLI sessions are `claude` processes it
  merely watches; a restart does not touch them), and
- any job run in status `running`. The other non-terminal statuses
  (`waiting_approval`, `sleeping`, …) are resumed by `initJobRunner` on the next
  boot and cost nothing.

Both are named in the refusal — job runs by title, chats by their title read out
of the record's metadata, falling back to the id. "1 chat is still streaming
(a2f7719c-…)" is not a sentence a user can act on.

**"Immediately before" is literal**, and it did not start that way. The check
used to run before the 500ms beat, and the helper then pays its own Node boot
before `cmdStop` signals — call it 0.7–1.5s in which a chat or a job step could
start and be killed mid-turn by a decision made before it existed. It now runs
*inside* the timer, on the far side of the delay, with nothing between it and
the spawn. The consequence for the wire is that a run can emit `update_verified`
twice: once as `restart: "pending"` before the beat, and once as `restart:
"refused"` if the re-check finds work. The banner's reducer already treats any
non-`pending` verdict as the end of the run, so that is a state it handles
rather than a new one.

A third source joined those two: **a running engine install**. A restart is
`process.exit(0)` out of `gracefulShutdown`, which orphans an `npm install -g`
part-way through writing the global tree — the same tree this daemon runs out of.
That destroys work as surely as a chat turn does, and it belonged in this list
rather than only in the *start* gate.

Busy ⇒ the restart is refused with a sentence naming what is busy, and the
banner says the new version takes effect on the next restart. Pressing the button
again when things are idle is a cheap no-op install followed by the restart that
was deferred; `callboard restart` in a terminal does the same. That retry
genuinely restarts now — see the boot-version section above for why it could not
before.

An unlistable job store counts as busy. "Callboard could not check" is not
permission to restart.

Chat and job titles interpolated into these sentences are normalised first —
backticks stripped, whitespace collapsed, then clipped to 60 characters. The
banner splits the sentence on backticks to render `<code>` spans, so a single
stray backtick from a chat titled ``fix the useEffect deps`` flips the parity of
everything after it and the rest of the refusal renders as one code span. This
code took `card-rollup.ts`'s *reading* of the metadata blob and not its
normalisation; the fallback source for a title is `preview`, which is a whole
first user message and can be several lines long.

### The lock, in the window where npm is not running

`npm-global-install.ts` holds two states, and for a while it held only one.
`npmInstallInFlight()` answers *"is npm writing the global tree right now"*, and
that is not the same question as *"is it safe to start writing it"*. Between a
self-update's npm exiting and its detached helper's SIGTERM landing — the 500ms
hand-over beat plus the helper's own Node boot, so one to two seconds — npm is
not running: `isInstallRunning()` and `npmInstallInFlight()` are both false, and
`startEngineInstall` had no third question to ask. An install accepted there is
also invisible to `describeWorkInFlight`, so the restart is not deferred for it
either — the daemon exits and the install is orphaned mid-write.

So a `restartPending` marker is parked next to `inFlight`, set where the restart
timer is scheduled and cleared wherever that timer is cleared (a work-in-flight
refusal inside it, a helper spawn that fails, the test seams). It is deliberately
*not* cleared on a successful spawn: for the seconds before this process is
killed, the correct answer is still "do not start writing". It lives in
`npm-global-install.ts` rather than being exported from `self-update.ts` because
`engine-install.ts` cannot import that module without a cycle, and this is where
both features already meet.

### Known limitation: a cron job firing during the restart

`cron-scheduler.ts` uses `node-cron`, which has no catch-up: a job whose schedule
falls inside the restart window is silently skipped rather than run late.
`describeWorkInFlight` does not look ahead at the schedule, and deliberately.

It is pre-existing — `callboard restart`, and `POST /api/restart`, which is
already a button in this UI, have always had it — and the obvious mitigation is
worse than the gap. Callboard writes a default heartbeat cron per agent
(`ensureDefaultCronJobs`), so on a daemon with several agents "does anything fire
in the next minute?" is true a large fraction of the time; making that refuse the
restart would convert a silently-skipped job run into an update button that never
works, which is the failure mode the PID-file section above is about. Making it
merely *warn* would need a third field on `describeWorkInFlight` and a caller
that could act on it, and the honest action is still "restart anyway".

The real fix is catch-up in the scheduler — a job that missed its window running
on the next boot, the way `initJobRunner` already resumes non-terminal job runs —
and that is a change to cron, not to this feature.

## Known limitation: the new frontend is live before the new backend is

`index.ts` serves the UI with `express.static(<pkgRoot>/frontend/dist)`, which
resolves per request, and npm replaced that directory in place. So from the
moment npm exits 0 the daemon serves the **new** bundle out of the **old**
backend — and on the deferred-restart path, where the user is explicitly told to
carry on working, it does so indefinitely. A reload in that window is a new
client against an old daemon: the reverse of the direction
`shared/types/stream.ts`'s compatibility rules cover, and not a case they make
any promise about.

What ships is the honest sentence, not a fix: every "installed, but not
restarted" verdict now says the new interface is already being served and that a
reload should wait for `callboard restart`. Snapshotting `frontend/dist` into
memory at boot would close it properly and is out of scope here.

The same sentence also names the second-daemon case, because that is the shape of
this limitation with no end: a sibling sharing the global install serves the new
bundle from its old backend *indefinitely*, since nothing is going to restart it.

Two smaller pieces of the same residue, unaddressed and recorded so they are not
rediscovered as bugs:

- Two runtime `await import()` call sites resolve against a package directory
  npm may have rewritten under them: `workspace-service.ts` → `claude.js` and
  `job-management-tools.ts` → `chat-lineage.js`. Both targets are also imported
  statically elsewhere, so in a daemon that has served anything they are already
  in the ESM registry and the dynamic import is a cache hit — the hazard is that
  this is a property of the current import graph rather than of the mechanism.
  A dynamic import of a module nothing else pulls in *would* load new code into
  an old process.
- `getServerBuildId()` is computed once and cached, so it keeps reporting the
  build the process started on. `StaleBundleBanner` compares against it, which
  means it will *not* offer a reload for this — correct, as it happens, since
  the reload is the thing to avoid until the restart.

## The success signal cannot come from the stream

The stream dies with the daemon, so `update_restarting` is the last frame a
client can receive **on the path that works**. The route does not close the
response on it, and that distinction is the whole of one bug: the frame
announces a spawn that has just been attempted, and the failure of that spawn —
`update_restart_failed`, reachable only because the daemon is still alive to
report it — arrives a moment later on the same connection. Ending the response
at `update_restarting` made that frame undeliverable, so the one case where the
daemon could explain itself looked identical to the case where it was gone: the
client waited out its 90-second poll and then advised downgrading a daemon that
had never restarted and was answering fine. Keeping the socket open costs
nothing on the ordinary path, where the process is about to close it by dying.

"Costs nothing on the ordinary path" is a bound supplied by something *not
happening in this code*, though, and a restart that hangs — the helper spawned,
`cmdStop` waiting out its own timeout, nothing ever signalling — leaves the
response open on a heartbeat with a `RunLog` listener attached. A browser tab is
harmless; a `curl` or a script holds that listener for the lifetime of the
daemon. So the route closes the response itself fifteen seconds after
`update_restarting`. That is far past the window in which
`update_restart_failed` can still arrive (a synchronous `spawn` throw or an
`error` event on the child, both within milliseconds) and past the ordinary one
to two seconds of helper boot plus SIGTERM, so it only ever fires when this
daemon is still alive — exactly the case where it can afford to act. Closing is
the whole action: no frame is invented, because a frame here would be a claim
about a restart nothing observed, and the client is already in the phase where a
stream ending is the expected shape of success.

The client's eleven-minute deadline **does** span the restart phase, for the same
reason the response stays open, and a comment claiming otherwise outlived the
change that made it false. Worse, the mechanism matched the comment: expiring
during `restarting` reported *"Callboard stopped reporting on this update 11
minutes ago"* for a daemon that was restarting exactly as designed, instead of
running the poll that is the only instrument that can tell the difference. The
phase is now asked first, as it is everywhere else in that file, and expiring in
`restarting` hands over to the 90-second poll like an ordinary stream ending
would. The deadline also aborts a controller of its own rather than the caller's
— "stop reading this socket" and "this component is gone" are different
statements, and collapsing them left the poll looking at a signal that was
already aborted.

The client then **polls** `/api/system-info` (bypassing the
stale-while-revalidate cache — `probeDaemonVersion`) until the daemon answers on
the version it said it installed, up to 90 seconds. Comparing against
`installedVersion` rather than "anything different" matters for the first couple
of seconds: the *old* daemon is still serving between the helper spawning and the
SIGTERM landing.

**How the read ended is never evidence of anything.** A successful update kills
the connection without closing the response, so the `fetch` rejects at the
moment everything is working; a refused restart closes it cleanly. The banner
therefore classifies on the *phase* it reached and swallows the exception
entirely. The version that rethrew unless the phase was exactly `restarting`
surfaced a raw "Failed to fetch" — as the whole account of a global npm install
running on the user's machine — for every Wi-Fi drop, laptop sleep and SIGKILLed
daemon. A raw `err.message` is now shown for one thing only: the POST failing,
where it really is the server's own one-line refusal.

`done` is exempt from that fall-through as well as `restarting`, or a socket
error arriving after a terminal `update_exit` would overwrite npm's own account
of the failure with a vaguer one.

The install phase has its own deadline, eleven minutes, mirroring the daemon's
ten-minute npm cap plus slack. A hung SSE — a buffering reverse proxy, a
half-open TCP connection, a lost FIN — otherwise leaves the phase at
`installing` forever with the button disabled and no way out but a reload, which
discards the run. It lands on the same "check the version at the top of this
page" warning. The 90-second restart poll was already bounded; this is the half
that was not.

The page is never reloaded automatically. `StaleBundleBanner` already watches the
daemon's build id and offers a reload the user chooses to take; reloading
underneath them would discard whatever they had typed elsewhere, which is the
trade that component exists to refuse.

## No rollback, and a loud way back

Callboard does not keep the previous tarball and does not try to reinstate it: a
rollback path nobody has ever exercised is a second way to break a machine that
is already unhappy. Instead the version being replaced is recorded three times
before the daemon goes away — in `update_restarting`, in
`<DATA_DIR>/self-update.json`, and in the log at `warn` — so a daemon that never
comes back is one command away from the version that worked:

```
npm install -g @wolpertingerlabs/callboard@<previous>
```

The poll's timeout message prints that command, and so does `callboard logs`.

## What is deliberately not built

- **Windows.** Refused by the shared preflight, for the reasons already recorded
  in `npm-global-install.ts`: the writability and PATH checks that justify the
  button do not hold there, and a capability check with a known hole is worse
  than no button.
- **Reattaching to an update across a page *reload*.** The engine installer does
  this with a `sessionStorage` pointer. Here the daemon holding that run is the
  one expected to be replaced, so the honest recovery for "I reloaded during an
  update" is the version printed at the top of this very page.

  Reattaching across a **component remount** is built, and is a different thing.
  `Settings.tsx` unmounts the About tab on a tab change, so leaving the tab and
  coming back during an update is one click — and it used to return an idle
  banner with an enabled button over a daemon that was still installing.
  Pressing it 409'd with "already updating" on a page showing no update, and the
  daemon could restart with nothing on screen. `GET /api/self-update` reports
  `activeUpdateId`, the stream replays its whole transcript on connect, and the
  banner attaches on mount when it sees one. Same page, same daemon, an id it
  just handed over — none of the reasons the reload case is declined apply.
- **Pinning a version.** The button installs `latest`, like the command it
  replaces. Anything else would be a version picker, and the registry already
  told this page which version is next.
- **A separate "restart now" endpoint** for the deferred-restart case. Pressing
  the button again is the retry, and it re-checks every gate on the way through.

## Surface

| | |
|---|---|
| `GET /api/self-update` | capability, **running** version, the version on disk, whether a restart is pending, package, command, any in-flight update id |
| `POST /api/self-update` | start one; returns `updateId` and the version being replaced |
| `GET /api/self-update/runs/:updateId/stream` | `update_started` → `update_output`* → `update_exit` → `update_verified` → `update_restarting` |

`POST` refuses with 409 while an update or an engine install holds npm's global
tree, and with 429 (`cooling-down`) for ten seconds after one finishes. The lock
alone says nothing about *rate*, and the global limiter is 300/minute — enough
for an authenticated LAN client to sit in a loop driving back-to-back
`npm install -g` runs against the package directory this daemon runs out of.
Same shape as the engine installer's cooldown, sized differently: it is short
enough not to be felt by the retry this feature actively tells people to make
("press it again once things are idle"). The refusal counts down.

That lock is symmetric in both directions now. `npm-global-install.ts` keeps one
marker for whatever global install is running, both features consult it before
starting, and each run stamps a token so that one finishing cannot clear
another's claim — which is what made an overlap survivable rather than merely
unlikely.

`SelfUpdateRefusalCode` has no `work-in-flight` member. A restart declined
because a chat is streaming happens *after* a successful install, so it is not a
refusal to start anything: it is `update_verified` with `restart: "refused"`. It
has no `no-pid-file` member either, for the same reason from the other
direction — nothing emits it, now that a daemon which cannot restart itself gets
a button and a declared disposition instead.

The rest of the codes stay. The client reads `oneClick` and renders `refusal`,
and never switches on `code` — but the *server* does (`not-local` and `disabled`
answer 403, the machine-state ones 422) and every one of them is logged.
Collapsing five distinct machine states into one placeholder would delete
information this daemon itself uses, and the standard the `work-in-flight` note
sets is narrower than that: a code **nothing can ever emit** is a false claim
about a response shape. One that is emitted, logged and not branched on by
today's single client is documentation doing its job.

`update-failed` was the exception, and it has been renamed to `run-not-found`. It
was documented as *"npm could not be started, or exited non-zero"* and described
nothing that ever emitted it — a failed install is an `update_exit` frame
carrying npm's own account, on a stream that is by definition still connected,
and never a refusal code at all. Its one emission site is the stream route's 404
for a run this daemon is not holding, which is what the name now says.

All three are LAN-only (`isDirectLocalClient`) and gated on
`AgentSettings.allowEngineInstalls` — the same switch as engine installs,
deliberately, rather than a second one an operator has to find. Remote-access
users never see the button: the restart calls `stopWebTunnel()`, so pressing it
would sever their own connection and a quick tunnel returns on a different URL.

Types live in `shared/types/selfUpdate.ts`. They are **not** part of the SSE wire
surface (`shared/types/stream.ts`), so `wire-surface.snapshot.json` does not
move.
