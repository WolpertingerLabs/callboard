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
await service.open(principal, targetId, signal?);      // Lease; observe before the first act
await service.observe(principal, sessionRef, signal?); // Observation { ...ref, frameId, frame }
await service.act(principal, actionRequest, signal?);  // SessionStatus
await service.takeover(humanPrincipal, sessionRef);    // Lease for that human actor
await service.resume(humanPrincipal, humanLeaseRef);   // Lease & { observation }
await service.stop(principal, sessionId);              // SessionStatus; idempotent fencing
await service.revoke(principal, sessionId);            // SessionStatus; irreversible for the session
await service.dispose();
const unsubscribe = service.subscribe(principal, (event) => {});
```

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
| Absolute session TTL                       | 15 minutes         |
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
- **Stop:** the session's `close` removes the container (`docker rm --force`) and its token directory, so every way the service ends a session (stop, revoke, TTL, a lost connection, `dispose`) removes it. A hook runs just before removal, while the container is still up, for copying the outbox out.
- **Labels:** `dev.callboard.managed=1`, the chat, the session, and an owner derived from Callboard's data directory. A reaper removes containers with Callboard's own owner label that belong to no live session, at startup and periodically, and never touches another owner's or an unlabelled container.
- **Network:** `callboard-sandbox` by default, or with internet access turned off, `callboard-sandbox-internal`: the same bridge with inter-container traffic off, plus `--internal`. Docker publishes no ports on an internal network, so there `sandboxRunArgs({ publish: false })` leaves the port unpublished and Callboard connects to the container's bridge address with `createRemoteDriver({ localDockerBridge: true })`, which accepts plain `http` to a private IPv4 literal. This needs the host to reach container bridge addresses: Docker Engine on Linux, not Docker Desktop or rootless Docker. `ensureSandboxNetwork({ internal })` refuses an existing network whose `--internal` setting differs.
- **The image** is never built or pulled implicitly: `callboard sandbox build` (or Callboard's Settings) runs `docker build` on this directory.

In **endpoint** mode, Callboard uses a container you run yourself instead:

- **Driver:** a `createRemoteDriver` built from `CALLBOARD_SANDBOX_DESKTOP_URL` and either `tokenFile: CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE` or `token: CALLBOARD_SANDBOX_DESKTOP_TOKEN` (discouraged). The file is read with `readTokenFile(path, { allowSymlink: true })` at each handshake, so a rotated or symlinked secret works. Empty variables count as unset.
- **Readiness:** with none set, the target probes unavailable with `readiness: "setup-required"`; with a partial or rejected setting, the same with the reason. A bad token file or an unreachable or incompatible host is the driver's own probe result (its fixed `reason`, with the host's detail only in `operatorDetail`, which Callboard shows only on the signed-in human's status view).
- **Kinds:** the remote driver's kind is `native-desktop`, so Callboard tells the two desktops apart by target id, never by driver kind.
- **Permission:** the target is gated on Callboard's own **Sandbox desktop** permission (`sandboxControl`) and nothing else. The container is the boundary, so the file and code permissions have nothing in it to govern, and its unrestricted outbound network is part of what that permission opts into, as for Browser Use. That network reaches this machine's all-interface services too (see above).
- **Consent:** bound to the endpoint and the `instanceId` the host proved in `POST /hello`, checked before the human is asked and again before opening, and then compared with `openedInstance(sessionId)` for the session that actually opened. A container replaced in between gets nothing.
- **Not yet:** Callboard doesn't sync the outbox.

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
- **Syncing and draining:** copying the outbox anywhere, and draining it before the container is destroyed, are the host's job.

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
- GPU, Wayland, macOS and Windows.
- Image-to-model vision across the five engine routes.
- Durable host policy, crash watchdogs, and drawing or modelling workflows.
