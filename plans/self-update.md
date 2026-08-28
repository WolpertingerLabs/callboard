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

## The gate that decides whether the button exists at all

`npm install -g @wolpertingerlabs/callboard` upgrades whatever lives under `npm
root -g`. That is **this** Callboard only when this Callboard was installed
globally. Started from a checkout — `npm run dev`, or `node
backend/dist/index.js` in a clone, which is how everyone working on Callboard
runs it — the install would succeed against a copy somewhere else, the restart
would reload the same unchanged source, and the observable result is a button
that does nothing.

Two conditions, both required, both checked per request:

1. **`<npm root -g>/<package>` resolves to this daemon's own package root**,
   symlinks resolved on both sides (a global prefix is very often reached
   through one — nvm, Homebrew, a moved `~/.npm-global`).
2. **`<DATA_DIR>/callboard.pid` names this process.** Not "exists": `callboard
   stop` SIGTERMs whatever pid it reads, so a stale file, or one written by a
   second Callboard sharing the data directory, would aim the restart at the
   wrong process. `callboard start --foreground` writes no pid file at all and
   correctly lands here.

Failing either, there is no button — and the refusal names the directory
Callboard is actually running from, because "no button" without that sentence is
indistinguishable from a bug.

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

The spawn is scheduled 500ms after the last two SSE frames, so they flush before
the socket dies with the process.

## Work in flight stops the restart, not the install

`gracefulShutdown` aborts in-flight agent turns. So immediately before the helper
is spawned — not before the install, which harms nothing — Callboard asks:

- any **web** session in the registry (CLI sessions are `claude` processes it
  merely watches; a restart does not touch them), and
- any job run in status `running`. The other non-terminal statuses
  (`waiting_approval`, `sleeping`, …) are resumed by `initJobRunner` on the next
  boot and cost nothing.

Busy ⇒ the restart is refused with a sentence naming what is busy, and the
banner says the new version takes effect on the next restart. Pressing the button
again when things are idle is a cheap no-op install followed by the restart that
was deferred; `callboard restart` in a terminal does the same.

An unlistable job store counts as busy. "Callboard could not check" is not
permission to restart.

## The success signal cannot come from the stream

The stream dies with the daemon, so `update_restarting` is the last frame a
client can receive. The client then **polls** `/api/system-info` (bypassing the
stale-while-revalidate cache — `probeDaemonVersion`) until the daemon answers on
the version it said it installed, up to 90 seconds. Comparing against
`installedVersion` rather than "anything different" matters for the first couple
of seconds: the *old* daemon is still serving between the helper spawning and the
SIGTERM landing.

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
- **Reattaching to an update across a page reload.** The engine installer does
  this with a `sessionStorage` pointer. Here the daemon holding that run is the
  one expected to be replaced, so the honest recovery for "I reloaded during an
  update" is the version printed at the top of this very page.
- **Pinning a version.** The button installs `latest`, like the command it
  replaces. Anything else would be a version picker, and the registry already
  told this page which version is next.
- **A separate "restart now" endpoint** for the deferred-restart case. Pressing
  the button again is the retry, and it re-checks every gate on the way through.

## Surface

| | |
|---|---|
| `GET /api/self-update` | capability, running version, package, command, any in-flight update id |
| `POST /api/self-update` | start one; returns `updateId` and the version being replaced |
| `GET /api/self-update/runs/:updateId/stream` | `update_started` → `update_output`* → `update_exit` → `update_verified` → `update_restarting` |

All three are LAN-only (`isDirectLocalClient`) and gated on
`AgentSettings.allowEngineInstalls` — the same switch as engine installs,
deliberately, rather than a second one an operator has to find. Remote-access
users never see the button: the restart calls `stopWebTunnel()`, so pressing it
would sever their own connection and a quick tunnel returns on a different URL.

Types live in `shared/types/selfUpdate.ts`. They are **not** part of the SSE wire
surface (`shared/types/stream.ts`), so `wire-surface.snapshot.json` does not
move.
