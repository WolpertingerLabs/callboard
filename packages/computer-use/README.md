# @wolpertingerlabs/computer-use · 0.1.0

A Node 22+ TypeScript library and MCP stdio server for agent-controlled browser and desktop sessions. It has no host-application imports. **Default deny, no targets configured, and nothing is installed automatically.** This is a preview; see [Tests and qualification](#tests-and-qualification) for what has and hasn't been verified.

## Install and build

```sh
# From this directory; no monorepo configuration is required.
npm install --ignore-scripts
npm run build
npm test
npm pack
```

The package is not published to npm, and shipping inside Callboard doesn't publish it. To use it elsewhere, install the tarball that `npm pack` produced:

```sh
npm install /absolute/path/to/wolpertingerlabs-computer-use-0.1.0.tgz
```

Playwright is an **optional** dependency, imported lazily. The core and the native driver work without it. Browser binaries must already be on the host; importing or probing never downloads them. The published files are the compiled JS, type declarations, the sandbox image's Docker context (`docker/`, `.dockerignore`), this README and the MIT licence.

## Public API

Types and `ComputerUseError` live in `src/contracts.ts` and are exported from both the package root and `./contracts`. The root also exports:

- `ComputerUseService`, `createComputerUseService(options?)`
- `createBrowserDriver(options?)`, `BrowserDriverOptions`
- `createNativeDesktopDriver(options?)`, `NativeDesktopDriverOptions`
- `createDriverHost(options)`, `readTokenFile(path, { allowSymlink? })`, `createRemoteDriver(options)` (with `openedInstance`, `listOutbox`, `downloadOutboxFile`), `sandboxRunArgs(options)`, `ensureSandboxNetwork(options?)`, `sandboxNetworkCreateArgs(name?, { internal? })`, `PROTOCOL`, `HOST_CAPABILITIES`, `SANDBOX_NETWORK`, `SANDBOX_INTERNAL_NETWORK`, `SANDBOX_IMAGE_LABELS`, and their types: see [Sandbox desktop container](#sandbox-desktop-container)
- `validateProfileRecipe`, `parseProfileRecipe`, `canonicalProfileRecipe`, `profileRecipeDigest`, `profileCompilerDigest`, `compileProfile`, `profilePackagesBuildArgs`, `profileImageBuildArgs`, `profileImageTag`, `profileEntryId`, `profileDownloadUrlProblem`, `clampProfileLimits`, `profileMaxHomeMb`, `profileSupportsArchitecture`, `PROFILE_LABELS`, `PROFILE_SECURITY_FLOOR`, `SANDBOX_BUILDER_IMAGE` and their types: see [Sandbox desktop profiles](#sandbox-desktop-profiles)
- `createMcpServer(service, principal): McpServer`
- `getToolDefinitions(service, principal): ToolDefinition[]`, `ToolDefinition`
- `actionSchema`, the Zod schema the service validates actions against, so a host can check an action before acting on it

```ts
interface Principal {
  readonly ownerId: string;
  readonly actorId: string; // Distinct authenticated controller/turn/viewer identity.
  readonly role: "agent" | "human";
}
interface SessionRef {
  sessionId: string;
  generation: number;
}
interface LeaseRef extends SessionRef {
  leaseId: string;
}
interface ActionRequest extends LeaseRef {
  frameId: string;
  actionId: string;
  action: Action;
}

const service = new ComputerUseService({ targets, authorize });
service.status(principal, sessionId?);                 // SessionStatus[]; redacted, no leases
await service.probe(principal, targetId);              // Probe
await service.open(principal, targetId, signal?, { ttlMs?, variant? }?); // Lease; observe before the first act
await service.observe(principal, sessionRef, signal?); // Observation { ...ref, frameId, frame }
await service.act(principal, actionRequest, signal?);  // SessionStatus
await service.takeover(humanPrincipal, sessionRef);    // Lease for that human actor
await service.resume(humanPrincipal, humanLeaseRef);   // Lease & { observation }
await service.stop(principal, sessionId);              // SessionStatus; idempotent fencing
await service.revoke(principal, sessionId);            // SessionStatus; irreversible for the session
await service.dispose();
const unsubscribe = service.subscribe(principal, (event) => {});
```

**Per-session options.** `open` takes an optional `{ ttlMs, variant }`, set by the host, never by a model. `ttlMs` is that session's absolute TTL, from 1 second to `maxSessionTtlMs` (a service option, which defaults to `sessionTtlMs`, so a host must opt in to longer sessions; at most 24 hours); out of range is `invalid_request`, never clamped. `variant` is an opaque selector (`[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}`) passed to the driver's `open` and shown in `status` (`SessionStatus.variant`); only a driver that declares `supportsVariants` receives one (any other `open` with a variant is `invalid_request`), so a selector is never silently ignored. Callboard uses it to name a Sandbox desktop profile. Both are checked before policy, so a malformed one never reaches the authorizer or the driver.

**Takeover and resume.** `takeover` and `resume` are trusted human control-plane APIs, never model tools. Human observation and input go through the same service, and human input requires the human lease. `resume` restores the original opener's immutable identity with a **new lease and generation**, and captures a fresh frame under that identity's current authorization before it returns. Hosts normally open sessions as an agent principal, even when a signed-in user clicks Enable.

**Leases.** Keep lease IDs in authenticated controller state, never in status listings or audit events. Opening a new MCP connection doesn't rotate an existing lease, and closing a transport doesn't revoke anything. Before retiring or rebinding a controller's turn identity, stop or revoke its sessions, or hand control over through the human control plane.

**Drivers.** A `Driver` has an immutable `kind` (`'browser' | 'native-desktop'`), `probe()`, `open({ sessionId, ownerId?, signal, onTargetChanged?, onLost? })`, an optional `lockDomain`, which is mandatory for native drivers, and an optional `lockScope`. With `lockScope: "driver"` (the default) every session of the driver shares its lock domain, so one is open at a time. `lockScope: "session"` is for a driver whose every `open` gets a device of its own, such as a fresh container per session: the lock is then the domain plus the session id. `ownerId` is the session owner's id, for a driver that labels what it creates; never authorize by it. `open` returns a `DriverSession` with `observe(signal)`, `act(action, signal)`, `releaseInput()` and `close()`. Driver code is trusted infrastructure, not a sandbox. A driver must:

- settle promptly on abort, release only the input it holds, and never mutate after settling
- leave existing native apps alone
- use screenshot pixel coordinates that equal input coordinates
- share a lock domain with anything that shares an input device (separate screens don't mean separate keyboards)
- call `onLost` if it loses its target out of band (the remote driver does when its connection drops); the service then fences the session `failed` at once instead of on the next call

**Probe readiness.** `Probe.readiness` is optional metadata: `setup-required`, `unsupported`, `permission-blocked` or `unknown`. Consumers need a generic fallback for missing or unknown values, and must not parse `reason`. Readiness grants nothing. `operatorDetail` is for operators only and is stripped from MCP probe results.

**Actions.** `Action` is a strict discriminated union: `click`, `move`, `drag`, `scroll`, `type`, `key`, `navigate` (browser only) and `wait`. There is no shell, eval, app launch, DOM evaluation, clipboard, upload, download or host file path. See the exported type for fields.

- Keys look like `Control+a`, `Enter`, `ArrowDown`.
- Holds and waits are capped at 2 seconds, and text at 4096 characters.
- Pointer coordinates are checked against an authorized frame.
- Native scroll maps every 100 pixels to one wheel step.
- Native typing chains up to 64 keys per `xdotool` call. Printable ASCII, newline and tab need no delay; any other character is typed through a remapped scratch keycode with a 10 ms per-key delay (about 20 ms per character), so a `type` action may contain at most 1000 of them; more is refused with `invalid_request` before any input is sent. A typing call is never killed part-way: abort is honoured between calls, which carry at most 16 such characters (about 350 ms), so no key is left held. Qualified live on Xvfb; see [Tests and qualification](#tests-and-qualification).

## Authorization and lifecycle

```ts
import { ComputerUseService, createBrowserDriver } from "@wolpertingerlabs/computer-use";

const service = new ComputerUseService({
  targets: [{ id: "isolated-browser", enabled: true, driver: createBrowserDriver() }],
  authorize: async (request) => {
    // Look up CURRENT trusted policy/grant, not model-supplied approval fields.
    // Intersect owner, actor/turn, target, kind, operation, session, generation,
    // expiry and host web/file/code permissions. Unattended ask is not allow.
    return "deny";
  },
});
```

**The authorizer.** It receives a frozen request with `principal`, `operation` (`probe | open | observe | act | takeover | resume`), `targetId` and `kind`, plus `sessionId` and `generation` when known. It returns `allow`, `deny` or `ask`. Missing, throwing, invalid or timed-out policy means deny.

**Ask.** `ask` immediately returns a typed `approval_required` error. It doesn't mint a grant, wait, or expose an approval tool. The host can record a pending approval, resolve it through its own authenticated control plane, and retry with a new action ID.

**Persistence.** The package doesn't persist approvals or revocations, and no authority survives a restart. A host that needs durable audit or revocation must persist its policy first, then call `revoke`.

**Identity.** Identity is bound out of band, at `createMcpServer` / `getToolDefinitions` time, and copied and frozen on each direct service call. Hosts must authenticate direct callers themselves. Each session has one owner. Action schemas accept no model-supplied owner, target switch, role or approval flag. Status, stop and revoke stay available to the owner even under deny. Events are owner-scoped metadata only: no pixels, text, URLs or leases.

**Enforcement timing.** Policy is checked at enqueue, at dequeue and at result delivery, screenshots included. `stop` and `revoke` synchronously bump the generation and abort the current epoch before they return, so stale, queued and future calls fail. Effects already in flight can't be rolled back, and images already delivered to a model can't be erased. Cleanup is asynchronous. An uncertain native lock isn't reused until the previous operation settles and cleanup succeeds.

**Failures.**

- A timed-out or cancelled input, or any driver fault, marks the session `failed`, because the driver's physical state is uncertain.
- A request refused before dispatch returns its typed error and leaves the session ready, so observe again and continue. Examples: coordinates outside the authorized frame, `navigate` on a native target, or a driver policy refusal such as navigating while offline.
- Late screenshots are discarded.

**Human takeover is a privacy boundary.** While a human controls a session, agents can't observe it, even if they read the new generation from status. Capture is blocked during the handoff, queued observations are fenced, and late images are dropped before delivery. Takeover waits for in-flight input to settle and release, and a stuck operation fails the handoff rather than giving a second controller access. Authorized human viewers can still observe a ready session. Only an explicit human `resume` restores agent observation.

**Defaults.**

| Setting                                    | Default            |
| ------------------------------------------ | ------------------ |
| Operation and policy timeout               | 30 seconds         |
| Queue depth                                | 16                 |
| Absolute session TTL                       | 15 minutes (`sessionTtlMs`, at most 2 hours; per session up to `maxSessionTtlMs`) |
| Active sessions                            | 16                 |
| Action IDs per session                     | 10,000             |
| `terminalRetentionMs`                      | 60 seconds         |
| Terminal records held                      | 1024               |

- A stopped, failed or revoked session stays visible in `status` for `terminalRetentionMs` after cleanup settles. After that its ID answers `not_found`. Audit history lives in events, not status.
- Duplicate action IDs are rejected rather than replayed, failed attempts included.
- Grants and frames are never written to disk.
- When host policy changes, call `revoke`. Changing a request filter alone doesn't stop background network traffic.
- `stop` fences control, but cleanup may still be in progress. `dispose` waits for cleanup; custom drivers must honour their bounded-settlement contract.
- Browser profiles are ephemeral, isolated per session, kept across turns while the session is open, and deleted on close. There is no profile recovery after a restart and no orphan-process reaper.

## Browser driver

The driver uses Playwright's `chromium.launchPersistentContext` with a private temporary profile: viewport 1280×800, headless by default, device scale 1. Screenshots, input, navigation and popup selection all share that context. Personal profiles can't be imported. A browser target **never** grants desktop access.

**The Chromium sandbox is mandatory** (`chromiumSandbox: true`). There's no switch to disable it and no `--no-sandbox` fallback. Provision a supported Chromium executable and its OS libraries. On Linux, run as a non-root user with the kernel or container support Chromium's sandbox needs: user namespaces and a compatible seccomp policy, or a supported sandbox helper. Do not bypass sandboxing to make a root/restricted-container deployment launch. Finding the executable doesn't prove the sandbox works. If a sandboxed launch fails, the driver throws `ComputerUseError('unsupported')` with sanitized diagnostics (which don't claim every launch failure was caused by the sandbox), removes the temporary profile, does not start a usable session, and leaves the host running.

**Options.** `headless`, `executablePath` (trusted operators only), `viewport`, `network` and an optional `allowRequest(url)`.

- `network` defaults to `offline`. Use `'unrestricted'` only when the operator allows broad browser networking, and `'externally-confined'` only when the host enforces its own OS or proxy boundary.
- Request filters deny on error. Service workers and WebSockets are blocked, file and non-HTTP(S) requests are denied, and downloads are cancelled.

These controls **are not a firewall or a filesystem sandbox**. DNS, browser internals, WebRTC and page behaviour need external confinement. Do not promise narrow egress or path policy from URL interception. A host with strict web or file restrictions must provide that confinement or refuse to enable the browser; browser mode is not a substitute for native desktop.

**How Callboard applies this.** Callboard runs the browser with `network: 'unrestricted'` and gates it on its own **Browser Use** permission, which it treats as the explicit opt-in to unrestricted browser networking. That is independent of the chat's Web Access permission: Web Access governs the agent's own fetch and search tools, not the browser, so a chat with Web Access on Deny can still browse once a human turns Browser Use on and enables the target. A host that needs Web Access restrictions to cover the browser too must confine the browser externally or leave Browser Use denied.

The package never evaluates JS in the page, but the website's own JavaScript still runs. File choosers aren't exposed. Chromium's own profile writes are infrastructure, not permission to touch host projects. See Playwright's [BrowserContext docs](https://playwright.dev/docs/api/class-browsercontext) for the limits of routing and service-worker blocking.

## Native desktop driver (Linux X11, explicit opt-in)

```ts
const driver = createNativeDesktopDriver({
  enabled: true,
  display: ":0", // Explicit operator selection; never reads ambient DISPLAY as the target.
  acknowledgeFullDesktopAccess: true,
  permissions: {
    webAccess: "allow",
    fileRead: "allow",
    fileWrite: "allow",
    codeExecution: "allow",
  },
});
```

**Prerequisites.** The operator provides `/usr/bin/xdotool` (XTEST), ImageMagick's `/usr/bin/import` and a reachable local X11 display. Nothing is installed or bundled. Screenshots come from `import -window root png:-`, and input comes from xdotool, run as a fixed executable with fixed argument vectors. No shell, string command evaluation or model-provided executable is used. The probe checks prerequisites and display geometry, not capture or input.

**Unavailable hosts.** A missing display, a disabled target, a headless host, Wayland/XWayland, an unsupported OS or missing commands produce an unavailable `Probe`, and `open` throws `ComputerUseError('unsupported')`. macOS, Windows and Wayland need a separately installed, qualified native `driver` plugin with a shared lock domain. There are no placeholder drivers that pretend to succeed, and the same compatibility gate applies to custom native helpers passed to this factory.

**X11 controls the whole desktop**, including terminals and apps that can read, write and reach the network. All four permission scopes must therefore be `allow`, and full-desktop access must be acknowledged explicitly. An `ask` or `deny` scope is rejected rather than silently weakened. Pixel or app-name filtering cannot enforce code, file or egress restrictions.

**Locking.** Native input has one process-wide lease, plus a cross-process lock directory per user and display: `computer-use-x11-<uid>/<sha256(lockDomain)>`, a private (`0700`) directory under the OS temp directory, recording the holder's PID.

- The next `open` reclaims a lock whose holder process is gone.
- If releasing input failed at close, the lock is **quarantined**, because a key or button may still be held down. A `quarantined` file records why, and the lock is never reclaimed automatically. The `lease_conflict` error names the path so an operator can check the desktop, release input and remove the directory.
- A live holder is never displaced.

There's no watchdog, so a killed process can leave input held; use an independently supervised, qualified helper for stronger crash recovery. Closing a native session releases input and detaches, but never kills apps or discards unsaved work. Physical keyboard and mouse use outside the service can't be locked out.

Command choices follow upstream [xdotool](https://github.com/jordansissel/xdotool/blob/main/xdotool.pod) and [ImageMagick import](https://imagemagick.org/script/import.php) documentation.

## Sandbox desktop container

The X11 driver can run inside a Docker container and be driven from another process over an authenticated loopback connection. The container is a **driver host**, not an MCP server and not a policy point: it exposes one local `Driver`'s `probe`, `open`, `observe`, `act`, `releaseInput` and `close` over HTTP, and everything that decides whether an operation may happen (authorization, leases, approvals, the 15-minute TTL) stays in the `ComputerUseService` that connects to it.

```ts
import { ComputerUseService, createRemoteDriver, ensureSandboxNetwork, sandboxRunArgs } from "@wolpertingerlabs/computer-use";
// docker run arguments with every hardening flag; the token only as a file path:
const args = sandboxRunArgs({ port: 0, tokenFile: "/private/dir/token", name: "sandbox-1", labels: { "dev.example.owner": "x" } });
await ensureSandboxNetwork(); // the bridge network those args name, with inter-container traffic off
const desktop = createRemoteDriver({ url: "http://127.0.0.1:7801", tokenFile: "/private/dir/token" });
const service = new ComputerUseService({ targets: [{ id: "desktop", enabled: true, driver: desktop }], authorize });
desktop.openedInstance(lease.sessionId); // the host instance a session actually opened on
await desktop.listOutbox(); // [{ name, size, sha256, mtimeMs }]
await desktop.downloadOutboxFile("report.pdf"); // { name, size, sha256, data: Buffer }, digest checked
```

**Build and run.** `docker/` ships in the published package, and the Dockerfile takes the compiled `dist/` (it installs only the runtime dependencies from `docker/package-lock.json` and compiles nothing), so the same context builds from a source checkout after `npm run build` and from an installed package. `.dockerignore` sends the daemon only `package.json`, `dist/` and `docker/`'s own files, with or without BuildKit. From this directory:

```sh
docker build -t callboard/computer-use-desktop:local -f docker/Dockerfile .
docker/run.sh 7801   # hardened flags, its own network, a fresh token in a private temp file, 127.0.0.1:7801
```

- **What `run.sh` prints:** `CALLBOARD_SANDBOX_DESKTOP_URL` and `CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE` for Callboard, and the commands to stop it, delete the token and remove the image.
- **Failure:** if it fails part-way, it removes the token it created.
- **Rebuilding:** it builds the image only if it's missing. After pulling changes, run it with `COMPUTER_USE_DESKTOP_REBUILD=1` (or `docker build` again). `docker rmi callboard/computer-use-desktop:local` removes the image.
- **Labels:** the image carries `org.opencontainers.image.version` (this package's version) and `dev.callboard.computer-use.protocol` (`"2.0"`), named by `SANDBOX_IMAGE_LABELS`, so a host can check compatibility before `docker run`.

**How Callboard wires it.** Callboard registers the container as its own target, `sandbox-desktop` (kind `sandbox` in its viewer API), next to `managed-browser` and `native-desktop`. It never replaces the local desktop. In its default, **managed** mode, Callboard runs the container itself, one per session, on the local Docker:

- **Start**, inside the target's `Driver.open`, after the human's consent: Docker reachable, `ensureSandboxNetwork`, the image present with a compatible `dev.callboard.computer-use.protocol` label, a fresh token file in a `0700` directory, `docker run` with `sandboxRunArgs` (port `0`, so `127.0.0.1::7801`, read back with `docker port`), a bounded wait for `POST /hello`, then `createRemoteDriver({ url, tokenFile })`. The session must open on the very `instanceId` that answered that hello. The driver says `lockScope: "session"`, so sandboxes of different chats never contend.
- **Stop:** the session's `close` removes the container (`docker rm --force`) and its token directory, so every way the service ends a session (stop, revoke, TTL, a lost connection, `dispose`) removes it. A hook runs just before removal, while the container is still up, for copying the outbox out: it gets the session's remote driver (`listOutbox`, `downloadOutboxFile(name, signal, { expectedSha256 })`; neither needs the closed session), the chat id, the chat's workspace id or folder, the `instanceId`, a `cause` (`session-end`, `shutdown` or `orphan`) and a bounded signal. Each session's metadata is persisted beside its token, so a reaper that finds a crashed run's container drains it the same way before removing it. The hook may return `{ keep: true }` to keep the container and its session directory on any of those paths. The keep is recorded in `session.json`, no reaper touches the container until the host releases it, and it no longer counts as a session. A hook that throws or times out never keeps anything.
- **Image freshness:** `sandboxImageBuildArgs({ context })` (what `callboard sandbox build` runs) and `docker/run.sh` label the image with `sandboxContentDigest(context)`, a digest of the files it was built from (`dev.callboard.computer-use.content`). A compatible image without the current digest still starts but is reported out of date. Another protocol major is refused.
- **Security floor:** the Dockerfile labels the image `dev.callboard.computer-use.security-floor`, an integer equal to `SANDBOX_SECURITY_FLOOR` (a test keeps them equal). A host refuses an image below it, or without the label ("known security issue — rebuild").
  - **When to bump it:** only for a security fix in the driver host or the image, one an existing image must not keep running without. Bump the label and the constant together.
  - **Why only then:** every older image then refuses to start until it is rebuilt. Ordinary changes are left to the content label: they show as out of date and keep working.
- **Outbox sync:** Callboard lists the outbox every few seconds while the session runs (backing off when nothing changes) and downloads each file with a digest, passing that digest as `expectedSha256`. A `sha256: null` entry under 64 MiB is still being written and is left for the next pass. At Stop the hook copies once more, waits a few seconds for files still being written, and verifies every listed file arrived with its digest. Files go to Callboard's data directory, never the project. See Callboard's README, **Deliverables (`~/outbox`)**, for the layout, limits and how they're shown in the chat.
- **Kept for recovery:** if that final copy fails, whatever the `cause` (including an orphan the reaper drains), Callboard's drain hook pauses the container (`docker pause`, not `docker stop`: the home, and so the outbox, is tmpfs, which a stop erases) and returns `{ keep: true }`. The manager records the keep in `session.json`, the one record of it, so a restart finds it kept rather than orphaned. Callboard bounds how many are kept and for how long (Settings), and ends a keep with `release()`: after a successful **Retry export**, on **Discard**, when the retention ends, or when the chat is deleted. Before copying, the hook checks the chat still exists; a deleted chat's outbox is discarded, not copied.
- **Labels:** `dev.callboard.managed=1`, the chat, the session, and an owner derived from Callboard's data directory. A reaper removes containers with Callboard's own owner label that belong to no live session, at startup and periodically, and never touches another owner's or an unlabelled container.
- **Network:** `callboard-sandbox` by default, or with internet access turned off, `callboard-sandbox-internal`: the same bridge with inter-container traffic off, plus `--internal`. Docker publishes no ports on an internal network, so there `sandboxRunArgs({ publish: false })` leaves the port unpublished and Callboard connects to the container's bridge address with `createRemoteDriver({ localDockerBridge: true })`, which accepts plain `http` to a private IPv4 literal. This needs the host to reach container bridge addresses: Docker Engine on Linux, not Docker Desktop or rootless Docker. `ensureSandboxNetwork({ internal })` refuses an existing network whose `--internal` setting differs.
- **The image** is never built or pulled implicitly: `callboard sandbox build` (or Callboard's Settings) runs `docker build` on this directory, twice: the final image, and its `builder` stage (`--target builder`, tagged `callboard/computer-use-desktop-builder:local`) that [profiles](#sandbox-desktop-profiles) build from.

In **endpoint** mode, Callboard uses a container you run yourself instead:

- **Driver:** a `createRemoteDriver` built from `CALLBOARD_SANDBOX_DESKTOP_URL` and either `tokenFile: CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE` or `token: CALLBOARD_SANDBOX_DESKTOP_TOKEN` (discouraged). The file is read with `readTokenFile(path, { allowSymlink: true })` at each handshake, so a rotated or symlinked secret works. Empty variables count as unset.
- **Readiness:** with none set, the target probes unavailable with `readiness: "setup-required"`; with a partial or rejected setting, the same with the reason. A bad token file or an unreachable or incompatible host is the driver's own probe result (its fixed `reason`, with the host's detail only in `operatorDetail`, which Callboard shows only on the signed-in human's status view).
- **Kinds:** the remote driver's kind is `native-desktop`, so Callboard tells the two desktops apart by target id, never by driver kind.
- **Permission:** the target is gated on Callboard's own **Sandbox desktop** permission (`sandboxControl`) and nothing else. The container is the boundary, so the file and code permissions have nothing in it to govern, and its unrestricted outbound network is part of what that permission opts into, as for Browser Use. That network reaches this machine's all-interface services too (see above).
- **Consent:** bound to the endpoint and the `instanceId` the host proved in `POST /hello`, checked before the human is asked and again before opening, and then compared with `openedInstance(sessionId)` for the session that actually opened. A container replaced in between gets nothing.
- **Outbox:** synced while the session runs and copied once more when it ends, as in managed mode, but nothing is ever removed, paused or kept. The outbox is shared, so a session is only given files new or changed since it opened.

**The token is a file, never an environment variable.** An environment variable shows in `docker inspect` and in every `docker exec` shell.

- **The host reads a file:** `COMPUTER_USE_HOST_TOKEN_FILE`, by default `/run/computer-use/token`, a read-only bind mount. It refuses to start if `COMPUTER_USE_HOST_TOKEN` is set at all.
- **`readTokenFile` checks it:** a symlink is refused unless the caller passes `allowSymlink`. So are a non-regular file, a group- or world-writable file, and anything other than one line of 32–4096 characters.
- **On your machine:** `run.sh` writes the token as a `0444` file inside a `0700` directory. The file has to be readable by "others" because the container's driver user isn't your uid; the directory is what keeps it private.
- **Inside the container:** the mount point's directory is `root:driver 0750`, so the desktop user can't even list it.
- **On the client side:** `createRemoteDriver({ tokenFile })` reads the file at every handshake, so a rotated token is picked up. It *does* follow symlinks: Kubernetes secrets and some credential stores are symlinks, and that path is chosen by the operator, not by anything on the desktop.
- **Verified by the Docker test:** the token appears in neither `docker inspect` nor any process environment, and the desktop user gets `Permission denied`.

**Hardening** (`sandboxRunArgs`; `run.sh` mirrors it, and a test keeps the two in step):

| Flag | Why |
| --- | --- |
| `--read-only`, `--tmpfs /tmp` (`noexec`, 64m), `--tmpfs /home/desktop` (512m) | Nothing persists. The only writable places are the desktop user's home (outbox included) and `/tmp` (the X socket directory). |
| `--cap-drop=ALL --cap-add=SETUID --cap-add=SETGID` | The entrypoint runs as root just long enough to start the desktop as `desktop`, then execs into tini as `driver`. The two added capabilities exist only for that split. Afterwards no process is root and none holds a capability (checked by the Docker test). |
| `--security-opt=no-new-privileges` | No setuid or file-capability gain. |
| `--pids-limit=256 --memory=1g --memory-swap=1g --cpus=1` | Defaults; pass `limits` to change them. |
| `--network=callboard-sandbox` | A user-defined bridge with inter-container communication off (`ensureSandboxNetwork` creates it, or refuses one with that name that is set up otherwise). Another container on it cannot reach the driver host, which listens on all the container's interfaces so the published port works. Verified by the Docker test. |
| `--publish 127.0.0.1:<port>:7801` | Loopback only. |
| `--mount type=bind,…token,readonly` | The only host path. No Docker socket, no devices, not privileged. |

**The other direction: the container can reach this machine.** No Docker flag stops a container on a bridge network from connecting to the host's own addresses, such as the bridge gateway (`172.x.0.1`). Any service on this machine that listens on all interfaces is reachable from the desktop. That includes Callboard itself, which today listens on every interface: a reviewer reached it from the desktop at `172.17.0.1:8000`. Bind host services to `127.0.0.1` where you can, or firewall the Docker bridge on the host, for example a `DOCKER-USER` or nftables rule that drops traffic from the sandbox network to the host.

**Outbound internet** is allowed on `SANDBOX_NETWORK`. `SANDBOX_INTERNAL_NETWORK` (`sandboxNetworkCreateArgs(name, { internal: true })`) has no route off the bridge, so no internet. Published ports don't work on an internal network, so run the container with `publish: false` and reach it at its bridge address (`localDockerBridge`), as Callboard does. Neither stops the container reaching this machine through the bridge (above). Narrower egress (an allow-list) needs an egress proxy or host firewall rules.

**Keep the port local.** To reach a container on another machine, put it behind a TLS proxy that authenticates. `createRemoteDriver` refuses plain `http` to anything but a loopback address. The token never crosses the wire, but screenshots and typed text do.

**What's in the image** (about 430 MB unpacked, 140 MB compressed):
- **Desktop:** Xvfb on `:99` at 1280×800×24, icewm, and one xterm (respawned if it exits) as the test target.
- **Tools:** `/usr/bin/xdotool`, ImageMagick's `/usr/bin/import`, DejaVu fonts plus WenQuanYi Micro Hei for CJK and Hangul.
- **Runtime:** Node 22 and this package, with only `zod` among its dependencies (the driver host loads nothing else).
- **No OpenGL:** Xvfb runs with `-extension GLX`, and Mesa's drivers are purged. `COMPUTER_USE_GL=none` in the image's environment says so; a [profile](#sandbox-desktop-profiles) built with `gl: "software"` sets it to `software`.

How it's built:
- The base image is pinned by digest, and the package builds with `npm ci` from `docker/package-lock.json`. That lock is pinned to the versions Callboard runs; `npm ci` fails if it drifts from `package.json`.
- No file has a setuid or setgid bit (they're stripped, and the Docker test checks), and the driver's temporary directory (`TMPDIR`, which holds its input lock) is created `0700` as `driver` before any desktop process starts. The desktop user therefore can't squat the lock.
- npm, npx and corepack are removed. Packages the dependency closure drags in but a headless, GL-less desktop never loads are purged: mesa's DRI drivers with LLVM and z3, `cpp`, and Ghostscript with its fonts.

Users and permissions:
- Two unprivileged users: `desktop` owns the X session and every app on it, and `driver` runs `computer-use-driver-host` and alone can reach the token.
- Inside the container the native driver runs with full-desktop access acknowledged and all four scopes on `allow`. That's correct there, because the container is the boundary.

**Protocol versioning and the handshake.** `PROTOCOL` is `{ major: 2, minor: 0 }`, so a daemon and a container from different releases can tell whether they understand each other.

- **`POST /hello` is unversioned and needs no credentials.** The client sends a fresh 32-byte nonce. The host answers with its `protocol`, `capabilities`, a per-process `instanceId`, `heartbeatMs` and hostname, plus `proof = HMAC-SHA256(token, ["computer-use/host-proof", nonce, instanceId, major, minor])`.
- **The client trusts nothing until that proof checks out against its own copy of the token.** A process that took the port after the real host went away gets a `denied` and was never sent anything but the nonce.
- **The token never travels.** Every later request carries `Authorization: Bearer <nonce>.<HMAC(token, ["computer-use/credential", instanceId, nonce])>`. That credential is bound to one host instance, so one captured from a host that has since gone or restarted is worthless.
- **What it doesn't stop:** an active relay to a live host. That needs channel binding (TLS), which is one more reason the port stays on loopback.
- **Major** breaks compatibility and is the URL prefix (`/v2`). The client sends `X-Computer-Use-Protocol: <major>.<minor>`, and the host refuses another major, or none, with `unsupported` (501). The client fails closed on a host whose hello reports another major, or that predates the handshake; a probe then reports `readiness: "unsupported"`. Protocol 1.0 sent the raw token on every request and is not accepted.
- **Minor** only adds. New behaviour is announced as a capability, and a client checks for the capability, never the minor number. A host advertises only what it serves: no outbox directory means no `outbox.list`/`outbox.get`.
- **The rules:** the same as for Callboard's stream types. Fields are added, never removed or renamed, and an existing field's meaning never changes. **Request bodies are strict**: the host rejects unknown fields, so a new request field needs a capability first. Responses are lenient: clients ignore fields they don't know.

**The driver host** (`createDriverHost({ driver, token, outboxDir? })`, or the `computer-use-driver-host` bin, configured by `COMPUTER_USE_*` environment variables):

- Refuses to start without a token of at least 32 characters.
- **Authentication:** it proves itself on `/hello`, and checks the instance credential on every other request, in constant time, before reading the body or the path. A refused request gets `Connection: close`, and the socket is destroyed.
- **Limits:** 32 connections, 10 s for headers, 15 s for a whole request, and 10 s to read a body once headers are in (`maxConnections`, `headersTimeoutMs`, `requestTimeoutMs`, `bodyTimeoutMs`). The attach stream's response is not bounded by them. A request whose body is refused or left unread also loses its connection.
- Validates every action with `actionSchema`, as the client does before sending it.
- Bounds each operation at 30 seconds and aborts it if the client goes away.
- Ties each session to a long-lived attach response with a ping every `heartbeatMs` (5 s by default, advertised in the hello). If that connection drops, the host aborts the running operation, releases input and closes the session. The client reads the same drop (or 3 × `heartbeatMs` without a ping, at least 3 seconds) as a lost connection, fails any in-flight call with `driver_error`, and calls `onLost`, so the service fences the session at once.
- Returns frames as PNG, with width and height read from the image itself. Coordinates are 1:1 with those pixels.
- Serves one session at a time; another `open` gets `lease_conflict`.

**Outbox.** `~/outbox` in the container (`/home/desktop/outbox`, on the home tmpfs) is listed with name, size, SHA-256 and `mtimeMs`, and served by name.

- **Plain names only:** no leading dot, no separators, at most 128 characters. So `..` and absolute paths are refused.
- **No following links, even mid-race.** The desktop user owns the outbox and its parent, so it can swap the outbox for a symlink at any moment. (A reviewer did exactly that, to `/run/computer-use`, and got the token served.) Now, for every request:
  1. The host opens the outbox directory itself with `O_NOFOLLOW`, so a symlink there fails.
  2. It confirms through `/proc/self/fd` that the directory it holds is the configured one.
  3. It opens each name *through that held directory* (`/proc/self/fd/<dirfd>/<name>`, i.e. `openat`) with `O_NOFOLLOW`.
  4. It serves the file only if it is a regular file on the outbox's own device, owned by the outbox's owner, and its fd still resolves to `<outbox>/<name>`.

  A unit test races a real swapper process against downloads and listings, and the Docker test replays the reviewer's swap. The driver host is Linux-only, as `/proc` is.
- **Digests:** a listing streams each file's hash and caches it by device, inode, size, mtime and ctime (ctime because a writer can set mtime back), so unchanged files aren't re-read. Files over 64 MiB are listed without a digest and not served, and a listing stops at 200 entries. The client checks a download's digest against the bytes it received.
- **Write `.name.part`, then rename to `name`.** Dot-names are never listed, and a rename is atomic, so a listing never sees a half-written file. A file that changed in the last second (`outboxSettleMs`), or changes while it's being hashed (re-checked with `fstat` afterwards, so a same-size rewrite in place is caught too), is listed with `sha256: null` and not cached. Pass a listed digest to `downloadOutboxFile(name, signal, { expectedSha256 })` to refuse a file that changed since (`stale_frame`).
- **Syncing and draining:** copying the outbox anywhere, and draining it before the container is destroyed, are the host's job (Callboard's, above). For agents and humans the rule is the same: write `~/outbox/.NAME.part`, then rename it to `~/outbox/NAME`, a plain name with no spaces or subfolders.

## Sandbox desktop profiles

The base image is deliberately bare: no package installs, no OpenGL, small limits, and everything gone after each session. A **profile** is a reusable image for one purpose (Blender, say), built once from a **recipe** and started fresh for every session with exactly the same run-time hardening (`sandboxRunArgs`); only its limits differ.

### Recipes

A recipe is JSON: strict to parse, unambiguous (no YAML type coercion, anchors or multiple documents), hashable in a canonical form, and what an agent proposing one produces most reliably. Every field is checked against a fixed grammar, unknown keys are errors, and every problem is reported with its path (`packages[3]: "Foo" is not a Debian package name (…)`). The built-ins live in `docker/profiles/` (`blender.json`, `test.json`).

```json
{
  "schema": 1,
  "name": "blender",
  "description": "Blender 4.5 LTS with software OpenGL.",
  "packages": ["libxi6", "libxkbcommon0"],
  "downloads": [
    { "url": "https://download.blender.org/release/Blender4.5/blender-4.5.17-linux-x64.tar.xz",
      "sha256": "b7d09d1a…", "dest": "blender", "unpack": "tar.xz", "stripComponents": 1 }
  ],
  "setup": ["/opt/blender/blender --version"],
  "path": ["/opt/blender"],
  "env": {},
  "gl": "software",
  "limits": { "cpus": 4, "memoryMb": 4096, "homeMb": 2048, "sessionMinutes": 60 }
}
```

| Field | Rule |
| --- | --- |
| `schema` | `1`. |
| `name` | 2–32 of `[a-z0-9-]`, starting with a letter; `base`, `default`, `builder`, `none` and `local` are reserved, and so are names starting `w` + 12 hex digits + `-` or ending `-packages` (they would collide with a workspace profile's tag or a package stage's tag). With its **scope** (`global`, or a workspace's `w<12 hex>`, chosen by the host, never the recipe) it makes the **entry id** `<scope>/<name>`, which names the image (`callboard/computer-use-profile:<name>` for `global`, `…:<scope>-<name>` otherwise) and the session variant. |
| `description` | One line of plain text, at most 300 characters: no control, line-separator or bidi characters. |
| `packages` | At most 300 Debian package names (`[a-z0-9][a-z0-9+.-]*[a-z0-9]`): no versions, architectures, releases or paths, and no trailing `-`/`+` (apt's remove/install suffixes). Installed from the builder's own Debian sources; a recipe cannot add a source. **Exact names only:** apt reads a name that is not an exact package name, and contains `.` or `+`, as an unanchored regex (`ne.cat` would install both netcats), so the install script refuses any name that `apt-cache pkgnames` does not list exactly (pure virtual packages included) before apt runs, and afterwards fails if apt marked any package manual that the recipe did not name. |
| `downloads` | At most 8. `url`: `https://`, a public host name (no IP literal, `localhost`, `.local`, `.internal` or bare name), no credentials or fragment. `sha256`: **required**. `dest`: unpacked into `/opt/<dest>` (`computer-use` and `profile` are reserved). `unpack`: `tar.gz`, `tar.xz`, `zip` or `file` (with `filename` and optional `executable`); `stripComponents` (0–8) for tar. |
| `setup` | A bash script (a string, or an array of lines), at most 32 KiB, no control characters but newline and tab. Runs at build time **as the desktop user**, with **no network**, `set -euo pipefail`, in a clean environment with the profile's `path` and `env`. It can write only to `/opt/profile` and the download destinations (and its own build-time home, which is not kept). |
| `path` | At most 16 directories under `/opt` or `/usr`, prepended to the desktop's `PATH`. |
| `env` | At most 32 variables (`[A-Z_][A-Z0-9_]*`, one-line values up to 1024 characters) for every desktop process. Reserved: `PATH`, `HOME`, `USER`, `SHELL`, `DISPLAY`, `TMPDIR`, `IFS`, `ENV`, `BASH_ENV`, `NODE_OPTIONS`, `GALLIUM_DRIVER` and the like, and anything starting `LD_`, `COMPUTER_USE_`, `CALLBOARD_`, `LIBGL_`, `MESA_`, `LP_` or `BASH_FUNC_`. |
| `gl` | `none` (the default: no GLX, as the base) or `software`: Mesa's llvmpipe (added to the packages) and Xvfb with GLX. |
| `limits` | Optional requests: `cpus` (0.5–32, steps of 0.01), `memoryMb` (512–65536), `homeMb` (256–65536), `sessionMinutes` (5–480). A host clamps each to its own caps (`clampProfileLimits`); an omitted one gets the host's base value. **The home counts toward memory:** it is a tmpfs, so its files use the container's memory, and a home as big as the memory limit gets the session OOM-killed. A home must leave the desktop `max(512 MiB, memory/4)` (`profileMaxHomeMb`): a recipe that asks for more is refused, and clamping (a lowered memory cap, or a home asked for alone) shrinks the home to fit. |
| `architectures` | Optional: the Docker host architectures it builds on (`amd64`, `arm64`); omitted or empty: any. A build on another one is refused before anything is downloaded, and the host shows the profile as not buildable here. Blender's official Linux build is `amd64` only. |

`canonicalProfileRecipe` is the recipe with every default filled in and keys in a fixed order: what is hashed, built, and should be shown to anyone reviewing one (raw JSON may repeat a key; the canonical form cannot). Errors quote every untrusted key and value with everything outside printable ASCII escaped (`env."A\u202eB": …`), so a hostile key cannot forge a line or reorder what a reader sees.

Two digests, two meanings. `profileRecipeDigest` hashes the canonical recipe alone: it is **what a human consents to**, and a profile image starts only if it was built from exactly that recipe. `profileCompilerDigest` hashes the compiler's own constant output (the Dockerfiles, the scripts, the epilogue) and `PROFILE_COMPILER_VERSION`: an image from another compiler is out of date, not refused, as an image on an older base is (a compiler change an image must not keep running without raises `PROFILE_SECURITY_FLOOR` instead).

### How a profile is built

`compileProfile(recipe)` returns two Docker build contexts. **Their Dockerfiles are constants** (`PROFILE_PACKAGES_DOCKERFILE`, `PROFILE_DOCKERFILE`): the same bytes for every recipe, with no continuations, heredocs or parser directives, and every `RUN` in exec form. A recipe reaches the build only as data files (`packages.txt`, `downloads.tsv`, `setup.sh`, `profile.env`), read by Callboard's own scripts, each of which checks its input again. So no recipe text can become a Dockerfile instruction, whatever it contains. A unit test compiles hostile recipes (newlines, `\` continuations, heredocs, `# syntax=` lines, `${…}` and `$(…)`, quotes) and checks the Dockerfiles are byte-identical and contain none of it.

1. **The builder.** The base Dockerfile's `builder` stage is the same desktop as the final image, users and files included, but with apt working and nothing purged, plus `libcap2-bin`, `xz-utils` and `unzip`. Profiles always build from it, by image ID.
2. **Downloads** are fetched by the host, over https, and kept only if their SHA-256 matches (Callboard caches them by digest and re-hashes before each use). Nothing is unpacked on the host.
3. **Packages** (first build, with the network): `apt-get install --no-install-recommends --no-remove` of the package list, as root. This is the only root step a recipe influences, and only by naming Debian packages: their maintainer scripts run as root at build time, but only Debian's.
4. **Profile** (second build, `--network=none`): the downloads are unpacked **as the desktop user** in a separate stage (so the archives never reach the image) and copied into `/opt`; the setup script runs as the desktop user.
5. **The epilogue**, last, as root, and never influenced by the recipe:
   - purges what the base purges, unless an installed package needs it (GL stays for `gl: "software"`);
   - removes apt, dpkg, npm, npx and corepack;
   - removes `/etc/ld.so.preload`, and the build's leftovers;
   - gives every file a user owns back to root (except the desktop's home and the token directory), removes world-write bits, strips every setuid/setgid bit and file capability, and runs `ldconfig`;
   - restores from the **final base image** (by ID): `/etc/passwd`, `group`, `shadow`, `gshadow` and `nsswitch.conf` (so a package cannot add a uid-0 account or an NSS module), the entrypoint, `profile-env`, the driver host, tini and node (each removed first, so the restore replaces rather than merges);
   - writes the profile's environment file, and then **verifies** all of it (users and uids, no second uid 0, no preload, no package tooling, no setuid or capability, nothing outside the home owned by a user, the token directory `root:driver 0750`, the trusted files present and root's, swrast present for `gl: "software"`) and fails the build otherwise;
   - sets `COMPUTER_USE_GL` from the `CALLBOARD_GL` build argument, which Callboard passes from the validated recipe, and ends as root with the trusted entrypoint.
6. **Labels**, set by `docker build --label`, never by the recipe: `dev.callboard.computer-use.profile` (the name), `.profile.scope`, `.profile.recipe` (the recipe digest), `.profile.compiler` (the compiler digest), `.profile.base-content` (the base content it was built on) and, for information, `.profile.base-image`, `.profile.gl`, and `.profile.security-floor` (`PROFILE_SECURITY_FLOOR`). The base's protocol and security-floor labels are inherited from the builder.

**At run time** a profile is started with `sandboxRunArgs`, like the base: only `cpus`, `memory` and `homeSize` change. The entrypoint decides GL from its own environment (`COMPUTER_USE_GL`, `none` or `software`; anything else refuses to start), never from a file the recipe wrote: `software` adds `+extension GLX` to Xvfb and gives desktop processes `LIBGL_ALWAYS_SOFTWARE=1`, `GALLIUM_DRIVER=llvmpipe` and `LP_NUM_THREADS` from the container's CPU quota. The profile's `PATH` and variables are read from `/etc/computer-use/profile.env` by `profile-env`, **as the desktop user** (after `setpriv` dropped root), line by line and never sourced, so nothing in a value is expanded or run. The entrypoint calls the desktop's helpers (Xvfb, xdotool, xhost, icewm, xterm) by absolute path.

A host judges a profile image like a base image, plus its own labels. **Refused:** another protocol major; below either security floor; not labelled as this profile's (name and scope: `unlabelled`); built from another recipe (`rebuild-required`: the consent was to this recipe, so a session never starts on an image built from another). **Out of date** (it still starts): built on other base *content*, or by another compiler. An out-of-date profile keeps running the driver host and the hardening of the build it came from until it is rebuilt, so rebuilding the base from new files makes every profile out of date. Staleness compares the base's content digest, not its image ID: a base rebuilt from identical files changes nothing a profile depends on.

### Agent-built profiles

Callboard lets an agent propose a recipe (`sandbox_profile_propose`, in the same tool server as the `cu_*` tools); a human approves **every** build. This package supplies the validator, the canonical form and the digest; the host (Callboard, `backend/src/services/sandbox-profile-proposals.ts` and `sandbox-profile-store.ts`) supplies the rest:

- **Validate, then store.** A proposal is checked with `validateProfileRecipe` (or `parseProfileRecipe` for JSON text); the agent gets every issue with its path, and nothing is stored. A valid one is stored, in canonical form with its `profileRecipeDigest`, as the next version of that profile in the proposing chat's **scope** (its workspace's, else its folder's). Paths come only from the scope key (`w` + 12 hex) and the name (the recipe grammar), checked before any `join`; directories are 0700, files 0600 and written atomically; a symlinked store directory is refused; on every read each version must re-parse, be canonical and hash to its stored digest, or it is dropped.
- **Approve, bound to the digest.** The human-only card shows the canonical recipe, its diff against the earlier version, and the risky parts (setup script, download hosts, package count, limits against caps, architectures, scope); the agent's note is boxed, escaped and capped. On approval the host re-reads the stored draft and refuses unless it is still the latest version with exactly the digest the card showed, re-checks the chat's permissions, the mode and the queue cap, then marks the version approved and queues one build **pinned to that digest** (`requestedBy: { kind: "agent", chatId, approvalId }`). The build fails before downloading anything if the recipe in force has another digest.
- **Only approved versions are entries.** A draft can be neither built nor started. A session starts only on an image labelled with the approved digest, after the usual consent.
- **Notices** to the agent are fixed templates whose only variables are Callboard-minted ids, a version number and an enumerated outcome: never the name, description, note, recipe or build output.
- **Human-only afterwards:** promote to global (same digest, versions and provenance kept, rebuilt under the global tag because the image's scope label differs), remove, rebuild.

### Threat model

**Assume the recipe author is hostile.** With agent-built profiles the author *is* an agent, and it may be prompt-injected by anything it read (a web page, a file, a build log). So a recipe must not be able to do anything the base sandbox cannot, and nothing in the path from proposal to build may let it skip the human.

- **What a recipe controls:** which Debian packages are installed; which pinned files are downloaded and unpacked into `/opt`; a script run as the unprivileged desktop user, offline, at build time; the desktop's `PATH` and some variables; GL on or off; resource requests.
- **What it cannot:**
  - *Inject build instructions:* the Dockerfiles are constants, the recipe is data, and every data file is validated twice (by the compiler and by the script that reads it).
  - *Run code as root*, except Debian's own maintainer scripts for the packages it names. It cannot add an apt source, key or option, pin a version, install a local `.deb`, or remove a package (`--no-remove`).
  - *Fetch anything unpinned*: downloads need a SHA-256, and the setup script has no network.
  - *Install packages it did not name:* names must be exact package names (apt's regex reading of a name with `.` or `+` is refused before apt runs), and the build fails if apt marked anything else manual.
  - *Start an image it was not consented as:* a session starts only on an image whose recipe label is the consented recipe's digest, checked again at start, and is started by the ID of the image that was checked (never its tag again, so a retag in between cannot slip in an unchecked image).
  - *Point the host's download at this machine or its network* (below).
  - *Keep a privilege into the image:* setuid/setgid bits, file capabilities, extra uid-0 accounts, `ld.so.preload`, package tooling and ownership by any user are all removed or reset by the epilogue and checked after it. Files under `/opt` are root's and, at run time, on a read-only root filesystem.
  - *Replace what root runs at start:* the entrypoint, `profile-env`, the driver host, tini, node and the account files are restored from the final base image after every recipe step; root reads no recipe-written file at run time (the environment file is read as the desktop user); GL is decided from Callboard's build argument; helpers are called by absolute path.
  - *Weaken the container:* run-time flags are `sandboxRunArgs`'s, identical for every profile; only CPUs, memory and the home size change, each clamped to the host's caps. No profile gets a device, a GPU, a mount, a capability or a network the base doesn't.
  - *Read the token:* `/run/computer-use` stays `root:driver 0750` (checked), and the driver host runs as `driver`, as in the base.
- **What remains, and is accepted or out of scope:**
  - **Debian packages are trusted**: their maintainer scripts run as root at build time, and a package may ship any file. The epilogue resets privileges and the trusted files, but a malicious Debian package could still, for example, change a shared library the driver host loads. The node image's sources are Debian `main` only.
  - **Downloads are as trustworthy as their pin**: a SHA-256 guarantees the bytes a human approved, not that they are benign. Whatever they contain runs as the desktop user inside the sandbox, which is what the sandbox is for.
  - **Build output is untrusted**: the setup script writes into it, and it reaches the operator's terminal (`callboard sandbox build --profile`) and the persisted build log. Every byte is piped and cleaned first: escape sequences (CSI, OSC, DCS…) are dropped whole, every other C0/C1 control character but newline and tab is dropped, and a carriage return becomes a line break. So a recipe cannot retitle the terminal (OSC 0), write the clipboard (OSC 52), or erase a line to print over it. It can still *print* a line that reads like Callboard's (`verify: ok`), on a line of its own; what decides a build is its exit status, which the log's last lines and the build record report.
  - **The host fetches the download URLs** (SSRF). Redirects are followed by hand, at most 5, and every hop is checked as a fresh URL (https, a public host name). Every hop's name is resolved by Callboard, and every address it resolves to must be public (no loopback, RFC 1918, link-local, CGNAT `100.64/10`, ULA `fc00::/7`, multicast, documentation, benchmarking or reserved ranges, no IPv4-compatible `::/96`, IPv4-mapped `::ffff:0:0/96` or IPv4-translated `::ffff:0:0:0/96` address, and no NAT64, 6to4 or Teredo one); the connection is then pinned to the address that was checked, so DNS rebinding between the check and the connect is impossible. A mismatched checksum is reported as a mismatch, never with the digest that arrived. What remains: a recipe can still make this machine send a few https GETs to public hosts of its choosing, and building is human-only and shows the URLs first.
  - **The build itself** runs on this machine's Docker with Docker's default build isolation, as root inside build containers for the package step. A kernel or Docker escape from a build container is out of scope, as it is for the base image.
  - **Resource use while building** (disk for packages and downloads, up to 4 GiB per download and 8 GiB per profile) is bounded but not small.
  - **Description, names and URLs are shown to humans**; they are plain text checked for control, line-separator and bidi characters, but can still say anything. They are never put in an agent's notices.
- **The proposal path (agent-built profiles):**
  - *Writing outside the store:* a store path is built only from a validated scope key and a validated name (no `.`, `/` or `\`); the scope is the proposing chat's, chosen by Callboard, never by the recipe or the tool input. Writes are temp-file-then-rename, so a planted symlink is replaced, not followed, and a symlinked directory is refused.
  - *Reaching root:* proposing runs nothing. Only an approved build runs the recipe, through the constant compiler above; the proposal path adds no new step that runs as root.
  - *Skipping the human:* there is no agent tool that approves, builds, rebuilds, promotes or removes. The card is a human-only open approval: only a signed-in, same-origin `/respond` that names its prompt id answers it (an API key is refused; a parent chat's `respond_to_request` sees only the blocking prompt slot, never these). Nothing is built without that answer, and no earlier approval carries over to a new version, or to the same recipe proposed again.
  - *Swapping the recipe after the human read it:* the approval is bound to the digest on the card, re-checked against the stored draft on approval (and that draft must be the latest version), and the build is pinned to the same digest; a stored version whose text no longer hashes to its digest is dropped on read.
  - *Shadowing a trusted name:* a proposal may not use the name of any global profile (built in or promoted), nor one this chat already sees in another scope; built-ins always win the lookup.
  - *Acting on another chat's work:* `sandbox_profile_cancel` acts only on builds whose `requestedBy.chatId` is the calling chat, and answers the same "not found" for anyone else's. Status lists only this chat's builds.
  - *Talking to the agent in Callboard's voice:* notices carry ids, a version and fixed text only. Build output reaches the agent only through `sandbox_profile_status`, labelled untrusted.
  - *Wearing down the human:* one open proposal per chat and per profile, and Settings caps on profiles per scope, versions kept and agent builds queued at once. Every proposal is still a card a human must answer; a refusal is final.
  - *Who may propose:* only a chat whose Sandbox desktop permission is Ask or Allow (children, jobs and agent chats default to Deny), in managed mode.
  - **Accepted:** an agent with its own way to write files on the Callboard host (a shell tool with host access) can write anything in the data directory, including this store; that is outside this model, as it is for every other setting. A store edit still cannot start an image built from another recipe, and the digest check drops a tampered version; but a human who clicks Rebuild builds what the store holds, which Settings shows first.

## MCP server

```sh
computer-use-mcp                                   # No enabled targets; default deny.
computer-use-mcp --config /absolute/trusted-config.mjs
```

**The config file** is trusted operator code, imported once at startup. It exports `options: ServiceOptions` and, optionally, `principal: Principal`. It must not be writable or selectable by a model or session, and it must not log to stdout, which belongs to MCP. Built-in diagnostics are generic stderr messages, without driver errors or screenshot/input contents. Replace the example's `deny` with a real external authorizer, never a model-supplied `approved` flag.

**Embedding.** `createMcpServer` returns the official SDK `McpServer`, so the host chooses the transport. Closing an embedded server doesn't dispose a shared service, because the host owns shutdown. The CLI disposes on EOF, SIGINT or SIGTERM, with a 5-second emergency exit.

**Tools.** `getToolDefinitions` defines the tools:

1. `computer_status` — `{ sessionId? }`
2. `computer_probe` — `{ targetId }`
3. `computer_open` — `{ targetId }`
4. `computer_observe` — `{ sessionId, generation }`
5. `computer_act` — `{ sessionId, generation, leaseId, frameId, actionId, action }`
6. `computer_stop` — `{ sessionId }`
7. `computer_revoke` — `{ sessionId }`

**Definitions and results.** Each definition is `{ name, description, inputSchema: z.ZodRawShape, handler(input, { signal }?) }`, and the server wraps the same handlers with strict Zod schemas. An observation returns text metadata plus a real `{ type: 'image', data, mimeType }` block. Errors are sanitized JSON text with `isError: true`. Results aren't sanitized, so `Probe.operatorDetail` (for example, the Chromium path a probe checked) is stripped from `computer_probe` explicitly; `Probe.reason` stays safe for any principal. An embedder that shows `operatorDetail` must serve it only on an authenticated operator surface.

There is no grant, approve, takeover or resume tool, no resource route for cached frames, and no provider SDK import. Harness discovery and image-to-model qualification remain integration work; an MCP image test alone does not prove model vision.

## Observation authority

A generation is a **control-lease epoch**, not a screenshot token.

- **Frames.** Every observation returns an unguessable UUID `frameId`, and an action must quote that exact ID. The service keeps at most one actionable frame per session, bound to the controller, generation and target revision, and rechecks it at execution, after asynchronous authorization. A newer capture by the controller supersedes older coordinates. Passive human previews of agent-controlled work grant no agent authority and don't replace the agent's frame.
- **Every action consumes its frame** before dispatch, even if the action partly fails, so observe again before the next action.
- **Other invalidation.** Navigation, page creation or closure, frame navigation, takeover, resume and stop also invalidate old frames. Drivers should call `onTargetChanged` whenever they detect a change.
- **Approvals.** A human approval binds one exact action and frame. A changed target or a newer controlling capture makes the approval stale rather than replayable. Missing or legacy IDs fail closed. `stale_frame` means capture again and ask again, not retry.

Pixels can't reveal every asynchronous change (animation, DOM updates, physical input, native app activity). These tokens fence **known** revisions; re-observe after any suspected change.

## Tests and qualification

```sh
npm test
# Opt in to a real, operator-provisioned Chromium for the live smoke test:
COMPUTER_USE_TEST_CHROMIUM=/absolute/path/to/chrome npm test
```

The live smoke test uses a disposable browser and a local fixture server. It covers real pixels, navigation, persistent form state, human input and resume, and cross-owner profile isolation. Without `COMPUTER_USE_TEST_CHROMIUM` it skips with a reason, and it never installs browsers. **CI doesn't set the variable**, so a passing `npm test` doesn't prove the live browser driver. When opted in, missing prerequisites or a failed sandboxed launch (`SANDBOXED_BROWSER_UNAVAILABLE`) fail the test rather than passing or retrying unsandboxed.

The offline suites cover:

- **Mocked launch:** mandatory sandbox options, sanitized failure, profile cleanup, and no fallback.
- **Fake drivers:** policy, identity, lease and generation races, takeover privacy at capture, queue and delivery, queued cancellation, revocation before image delivery, TTL, and native incompatibility.
- **MCP:** real in-memory initialize/list/call, stdio subprocess discovery, and a stdio run whose enabled target has no authorizer and must deny `probe` and `open` without opening the driver.
- **Native lock directory:** PID record, dead-holder reclaim, quarantine and concurrent reclaim, all without a display.
- **Native typing:** chained `xdotool` argument vectors, delay only for remapped characters, and the 1000-character refusal.
- **Sandbox profiles:** every built-in recipe valid; hostile keys and values escaped in errors; the home-within-memory rule; architectures; separate recipe and compiler digests; scoped tags; the exact-name install script; exact, path-prefixed validation errors; canonical form and digest; hostile recipe text (newlines, continuations, heredocs, directives, substitutions) never reaching the constant Dockerfiles; the epilogue present, last, and only Callboard's steps; the data files; the build arguments and labels; limit clamping; `profile-env` exporting values verbatim and running nothing; the entrypoint deciding GL from its own environment; per-session TTLs (bounded, defaulting to the service TTL, expiring on their own schedule) and the variant reaching the driver and status.
- **Sandbox run arguments:** every hardening flag, the network argv (and its `--internal` variant), `publish: false`, `ensureSandboxNetwork` through a caller's runner (creating, and refusing an ICC or internal/external mismatch), input validation, `run.sh` kept in step, the image labels matching `package.json` and `PROTOCOL`, and the Docker context shipping in the package and building from `dist/`.
- **Lock scope:** a `lockScope: "session"` driver serves concurrent sessions and receives the owner id; the default scope still allows one.
- **Remote driver host:** the handshake (a squatting host without the token learns nothing and gets no request past `/hello`; credentials for another instance or secret are refused), protocol negotiation failing closed in both directions (another major, none, a missing capability), slow and oversized requests cut off, `maxConnections`, the attach stream outliving the request deadline, the probe's fixed human words and readiness whitelist, `openedInstance`, token files (symlinks on the client side), the outbox symlink race, digest caching and the `.part` convention, token refusal on every endpoint, schema refusal on both sides, abort and operation bounds, disconnect and heartbeat fencing through the service, open cancellation, outbox path safety (`..`, absolute paths, hidden files, directories, symlinks, size cap) and digest checking.

**Live remote desktop (opt-in, needs Docker):**

```sh
CALLBOARD_DOCKER_TESTS=1 npm test
```

This builds the image and runs it with `sandboxRunArgs` (every hardening flag) on a random `127.0.0.1` port, with a random token in a read-only mounted file. Then it checks:

- **As Docker reports it:** the image labels; the handshake (and the raw token refused as a credential); the hardening settings themselves; a neighbour on the same network blocked while the same probe from the sandbox's own namespace gets through; no setuid files; the driver's private temp directory, with a desktop-user squat of the old lock path not stopping a session; the token absent from `docker inspect` and from every process environment; no process running as root or holding a capability; the token file unreadable by the desktop user; the root filesystem read-only; a CJK font present.
- **Through `createRemoteDriver` and `ComputerUseService`:** probe; open; a 1280×800 PNG frame; pointer coordinates equal to screenshot pixels (`xdotool getmouselocation` at the corners); typing, a key chord and Enter each changing the frame; non-ASCII typing with the pointer still responsive afterwards; a file written into the outbox by typing a shell command in the terminal, then listed and downloaded with a matching digest; a binary file written with `docker exec`, likewise; a symlink not listed and not served; the outbox swapped for a symlink to the token's directory refused; stop and reopen; and `docker kill` under a live session fencing it `failed` with no further call. The container is always removed; the image is left in place. Without the variable the test is skipped.

**Native X11 driver, qualified on Xvfb (inside the container):** screenshots; pointer `move`, left/right `click`, `drag` (exact end points; a title-bar drag moves the window by exactly the requested distance) and `scroll`; key chords such as `Shift+a`, `Control+A`, `Control+u`, `Enter`, `Tab`, `Escape`, `F1`, with no modifier left held afterwards; typing of all 95 printable ASCII characters, Latin-1, `€`, arrows, CJK and emoji (byte-exact, checked by typing into `cat > file`); 4000 ASCII characters in about 0.6 s; 1000 CJK characters in about 21 s; an aborted `type` fencing the session. Found and fixed while qualifying:

- **Typing was too slow for its own limit.** Two `xdotool` processes per character came to about 30 ms each, so a 1500-character `type` timed out at 30 s and failed the session, though the schema allows 4096. Keys are now chained per call.
- **Chaining without a delay drops non-ASCII characters**, because each one is typed through a scratch keycode that xdotool remaps and the client reads it after the mapping has moved on. Those characters keep a 10 ms per-key delay.
- **Non-ASCII typing can freeze the pointer under some window managers.** Each remap sends every client a keyboard `MappingNotify`. Under a UTF-8 locale openbox spends about 80 ms on each, falls minutes behind on a long string, and meanwhile holds its click-to-focus pointer grab, so the pointer stops moving. The image uses icewm, which keeps up. This is a property of the desktop, not the driver: on another X desktop, check the window manager the same way.

- **A key could be left held when typing was cancelled.** Killing `xdotool` between a keydown and its keyup left that key down, and for a remapped character a later keyup by keysym can miss the scratch keycode it was pressed on. A typing call is now never killed: abort waits for the current call, which is short. Verified live: cancelling a 300-character non-ASCII `type` settled in 68 ms, and the next session typed exactly.

Under the hardened flags (1 CPU, 1 GB), 1000 CJK characters still type in about 21 s with the pointer responsive straight after, and CJK and Hangul render (WenQuanYi Micro Hei).

**Not qualified:**

- Live sandboxed browser operation. Earlier Chromium smoke passes predate the sandbox fix, and the sandboxed smoke couldn't run on the build host.
- A live native desktop other than Xvfb in the container above: a physical X server, other window managers and toolkits.
- GPU (profiles have software OpenGL only), Wayland, macOS and Windows.
- Image-to-model vision across the five engine routes.
- Durable host policy, crash watchdogs, and drawing or modelling workflows.
