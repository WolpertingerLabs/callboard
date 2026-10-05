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

Playwright is an **optional** dependency, imported lazily. The core and the native driver work without it. Browser binaries must already be on the host; importing or probing never downloads them. The published files are the compiled JS, type declarations, this README and the MIT licence.

## Public API

Types and `ComputerUseError` live in `src/contracts.ts` and are exported from both the package root and `./contracts`. The root also exports:

- `ComputerUseService`, `createComputerUseService(options?)`
- `createBrowserDriver(options?)`, `BrowserDriverOptions`
- `createNativeDesktopDriver(options?)`, `NativeDesktopDriverOptions`
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

**Takeover and resume.** `takeover` and `resume` are trusted human control-plane APIs, never model tools. Human observation and input go through the same service, and human input requires the human lease. `resume` restores the original opener's identity with a **new lease and generation**, and captures a fresh frame under that identity's current authorization before it returns. Hosts normally open sessions as an agent principal, even when a signed-in user clicks Enable.

**Leases.** Keep lease IDs in authenticated controller state, never in status listings or audit events. Opening a new MCP connection doesn't rotate an existing lease, and closing a transport doesn't revoke anything. Before retiring or rebinding a controller's turn identity, stop or revoke its sessions, or hand control over through the human control plane.

**Drivers.** A `Driver` has an immutable `kind` (`'browser' | 'native-desktop'`), `probe()`, `open({ sessionId, signal, onTargetChanged? })`, and an optional `lockDomain`, which is mandatory for native drivers. `open` returns a `DriverSession` with `observe(signal)`, `act(action, signal)`, `releaseInput()` and `close()`. Driver code is trusted infrastructure, not a sandbox. A driver must:

- settle promptly on abort, release only the input it holds, and never mutate after settling
- leave existing native apps alone
- use screenshot pixel coordinates that equal input coordinates
- share a lock domain with anything that shares an input device (separate screens don't mean separate keyboards)

**Probe readiness.** `Probe.readiness` is optional metadata: `setup-required`, `unsupported`, `permission-blocked` or `unknown`. Consumers need a generic fallback for missing or unknown values, and must not parse `reason`. Readiness grants nothing. `operatorDetail` is for operators only and is stripped from MCP probe results.

**Actions.** `Action` is a strict discriminated union: `click`, `move`, `drag`, `scroll`, `type`, `key`, `navigate` (browser only) and `wait`. There is no shell, eval, app launch, DOM evaluation, clipboard, upload, download or host file path. See the exported type for fields.

- Keys look like `Control+a`, `Enter`, `ArrowDown`.
- Holds and waits are capped at 2 seconds, and text at 4096 characters.
- Pointer coordinates are checked against an authorized frame.
- Native scroll maps every 100 pixels to one wheel step.
- Native Unicode typing is sent key by key. It can be slow, depends on the keyboard layout, and hasn't been qualified on a live target.

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

**Persistence.** The package doesn't persist approvals or revocations, and no authority survives a restart. A host that needs durable audit or revocation must persist its policy and call `revoke`.

**Identity.** Identity is bound out of band, at `createMcpServer` / `getToolDefinitions` time, and copied and frozen on each direct service call. Hosts must authenticate direct callers themselves. Each session has one owner. Action schemas accept no model-supplied owner, target switch, role or approval flag. Status, stop and revoke stay available to the owner even under deny. Events are owner-scoped metadata only: no pixels, text, URLs or leases.

**Enforcement timing.** Policy is checked at enqueue, at dequeue and at result delivery, screenshots included. `stop` and `revoke` bump the generation and abort the current epoch before they return, so stale, queued and future calls fail. Effects already in flight can't be rolled back, and images already delivered to a model can't be erased. Cleanup is asynchronous. An uncertain native lock isn't reused until the previous operation settles and cleanup succeeds.

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
- `stop` fences control, but cleanup may still be in progress. `dispose` waits for cleanup.
- Browser profiles are ephemeral, isolated per session, kept across turns while the session is open, and deleted on close. There is no profile recovery after a restart and no orphan-process reaper.

## Browser driver

The driver uses Playwright's `chromium.launchPersistentContext` with a private temporary profile: viewport 1280×800, headless by default, device scale 1. Screenshots, input, navigation and popup selection all share that context. Personal profiles can't be imported. A browser target **never** grants desktop access.

**The Chromium sandbox is mandatory** (`chromiumSandbox: true`). There's no switch to disable it and no `--no-sandbox` fallback. On Linux, run as a non-root user with the kernel or container support Chromium's sandbox needs: user namespaces and a compatible seccomp policy, or a supported sandbox helper. Finding the executable doesn't prove the sandbox works. If a sandboxed launch fails, the driver throws `ComputerUseError('unsupported')` with sanitized diagnostics, removes the temporary profile, and leaves the host running.

**Options.** `headless`, `executablePath` (trusted operators only), `viewport`, `network` and an optional `allowRequest(url)`.

- `network` defaults to `offline`. Use `'unrestricted'` only when the operator allows broad browser networking, and `'externally-confined'` only when the host enforces its own OS or proxy boundary.
- Request filters deny on error. Service workers and WebSockets are blocked, file and non-HTTP(S) requests are denied, and downloads are cancelled.

These controls **are not a firewall or a filesystem sandbox**. DNS, browser internals, WebRTC and page behaviour need external confinement. A host with strict web or file restrictions must provide that confinement or refuse to enable the browser.

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

**Prerequisites.** The operator provides `/usr/bin/xdotool` (XTEST), ImageMagick's `/usr/bin/import` and a reachable local X11 display. Nothing is installed or bundled. Screenshots come from `import -window root png:-`, and input comes from xdotool, run with fixed argument vectors and no shell. The probe checks prerequisites and display geometry, not capture or input.

**Unavailable hosts.** A missing display, a headless host, Wayland/XWayland, an unsupported OS or missing commands produce an unavailable `Probe`, and `open` throws `ComputerUseError('unsupported')`. macOS, Windows and Wayland need a separately installed, qualified native `driver` plugin with a shared lock domain. There are no placeholder drivers that pretend to succeed, and the same compatibility gate applies to custom native helpers passed to this factory.

**X11 controls the whole desktop**, including terminals and apps that can read, write and reach the network. All four permission scopes must therefore be `allow`, and full-desktop access must be acknowledged explicitly. An `ask` or `deny` scope is rejected rather than silently weakened.

**Locking.** Native input has one process-wide lease, plus a cross-process lock directory per user and display: `computer-use-x11-<uid>/<sha256(lockDomain)>` under the OS temp directory, recording the holder's PID.

- The next `open` reclaims a lock whose holder process is gone.
- If releasing input failed at close, the lock is **quarantined**, because a key or button may still be held down. A `quarantined` file records why, and the lock is never reclaimed automatically. The `lease_conflict` error names the path so an operator can check the desktop, release input and remove the directory.
- A live holder is never displaced.

There's no watchdog, so a killed process can leave input held. Closing a native session releases input and detaches, but never kills apps or discards unsaved work. Physical keyboard and mouse use outside the service can't be locked out.

Command choices follow upstream [xdotool](https://github.com/jordansissel/xdotool/blob/main/xdotool.pod) and [ImageMagick import](https://imagemagick.org/script/import.php) documentation.

## MCP server

```sh
computer-use-mcp                                   # No enabled targets; default deny.
computer-use-mcp --config /absolute/trusted-config.mjs
```

**The config file** is trusted operator code, imported once at startup. It exports `options: ServiceOptions` and, optionally, `principal: Principal`. It must not be writable or selectable by a model or session, and it must not log to stdout, which belongs to MCP. Built-in diagnostics go to stderr without screenshot or input contents. Replace the example's `deny` with a real external authorizer, never a model-supplied `approved` flag.

**Embedding.** `createMcpServer` returns the official SDK `McpServer`, so the host chooses the transport. Closing an embedded server doesn't dispose a shared service, because the host owns shutdown. The CLI disposes on EOF, SIGINT or SIGTERM, with a 5-second emergency exit.

**Tools.** `getToolDefinitions` defines the tools:

1. `computer_status` — `{ sessionId? }`
2. `computer_probe` — `{ targetId }`
3. `computer_open` — `{ targetId }`
4. `computer_observe` — `{ sessionId, generation }`
5. `computer_act` — `{ sessionId, generation, leaseId, frameId, actionId, action }`
6. `computer_stop` — `{ sessionId }`
7. `computer_revoke` — `{ sessionId }`

**Definitions and results.** Each definition is `{ name, description, inputSchema: z.ZodRawShape, handler(input, { signal }?) }`, and the server wraps the same handlers with strict Zod schemas. An observation returns text metadata plus a real `{ type: 'image', data, mimeType }` block. Errors are sanitized JSON text with `isError: true`. Results aren't sanitized, so `Probe.operatorDetail` (for example, the Chromium path a probe checked) is stripped from `computer_probe` explicitly. An embedder that shows `operatorDetail` must serve it only on an authenticated operator surface.

There is no grant, approve, takeover or resume tool, no resource route for cached frames, and no provider SDK import.

## Observation authority

A generation is a **control-lease epoch**, not a screenshot token.

- **Frames.** Every observation returns an unguessable UUID `frameId`, and an action must quote that exact ID. The service keeps at most one actionable frame per session, bound to the controller, generation and target revision, and rechecks it after asynchronous authorization. A newer capture by the controller supersedes older coordinates. Passive human previews of agent-controlled work grant no agent authority and don't replace the agent's frame.
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

**Not qualified:**

- Live sandboxed browser operation. Earlier Chromium smoke passes predate the sandbox fix, and the sandboxed smoke couldn't run on the build host.
- Any live native desktop.
- GPU, Wayland, macOS and Windows.
- Image-to-model vision across the five engine routes.
- Durable host policy, crash watchdogs, and drawing or modelling workflows.
