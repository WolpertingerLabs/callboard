# @wolpertingerlabs/computer-use · 0.1.0

Extraction-ready Node 22+ / TypeScript library and standard MCP stdio executable. No host-application imports. **Default deny, no targets, no automatic browser/app installation.** This is a preview, not a claim of OS, engine, model-vision, or application-workflow qualification.

## Install / build

```sh
npm install @wolpertingerlabs/computer-use
# From this package's source directory (independent of any monorepo):
npm install --ignore-scripts
npm run build
npm test
npm pack
```

Playwright is an **optional**, lazily imported dependency. Browser binaries must already be provisioned by the operator; import/probe never downloads them. Removing Playwright does not prevent importing the core or using a native driver. Published files include JS, declarations, README and MIT license. No root workspace configuration is required.

## Exact public API

Types and `ComputerUseError` are in `src/contracts.ts`, exported from the package root and `./contracts`. Root additionally exports:

- `ComputerUseService`, `createComputerUseService(options?)`
- `createBrowserDriver(options?)`, `BrowserDriverOptions`
- `createNativeDesktopDriver(options?)`, `NativeDesktopDriverOptions`
- `createMcpServer(service, principal): McpServer`
- `getToolDefinitions(service, principal): ToolDefinition[]`

```ts
interface Principal {
  readonly ownerId: string;
  readonly actorId: string; // Distinct authenticated controller/turn/viewer identity.
  readonly role: 'agent' | 'human';
}
interface SessionRef { sessionId: string; generation: number }
interface LeaseRef extends SessionRef { leaseId: string }
interface ActionRequest extends LeaseRef { actionId: string; action: Action }

const service = new ComputerUseService({ targets, authorize });
service.status(principal, sessionId?);             // SessionStatus[]; redacted, no leases
await service.probe(principal, targetId);          // Probe
await service.open(principal, targetId, signal?);  // Lease; observe before first act
await service.observe(principal, sessionRef, signal?); // Observation { ...ref, frame }
await service.act(principal, actionRequest, signal?);  // SessionStatus
await service.takeover(humanPrincipal, sessionRef);    // Lease for that human actor
await service.resume(humanPrincipal, humanLeaseRef);  // Lease & { observation }
await service.stop(principal, sessionId);          // SessionStatus; idempotent fencing
await service.revoke(principal, sessionId);        // SessionStatus; irreversible for session
await service.dispose();
const unsubscribe = service.subscribe(principal, event => {});
```

`resume` restores the immutable original opener identity with a **new lease and generation**, and captures a fresh frame under that identity's current authorization before returning. Normally the host opens using an agent principal even when an authenticated user clicks Enable. Human observations/input use the same service; human input requires the human lease. `takeover`/`resume` are **trusted human control-plane APIs only**, never model tools. Keep lease IDs in authenticated controller state, not status listings or audit events. Opening a new MCP connection does not itself rotate an existing lease. Hosts must stop/revoke the old controller's sessions before retiring/rebinding its turn identity, or explicitly hand control through the human control plane; transport close alone is not a service revocation.

A `Driver` has immutable `kind: 'browser' | 'native-desktop'`, `probe()`, `open({sessionId, signal})`, and an optional `lockDomain` (mandatory for native). `open` returns a `DriverSession` with `observe(signal)`, `act(action, signal)`, `releaseInput()`, and `close()`. Driver code is privileged trusted infrastructure, not a security sandbox. It must settle promptly on abort, release only its held input, never mutate after settlement, and preserve pre-existing native apps. Screenshot pixel coordinates must equal input coordinates. Share lock domains for any shared input device; separate native display screens do not imply independent keyboards.

`Action` is a strict discriminated union: `click`, `move`, `drag`, `scroll`, `type`, `key`, `navigate` (browser only), `wait`. No arbitrary shell/eval, app launch, DOM evaluation, clipboard, upload/download API or host file paths. See the exported type for exact fields. Keys use e.g. `Control+a`, `Enter`, `ArrowDown`. Holds/waits are at most 2 seconds, text at most 4096 characters, pointer coordinates are checked against an authorized frame. Native scroll maps each 100 pixels to a wheel step. Native Unicode typing is conservative per-key input and may be slow/layout-dependent; it needs live target qualification.

## Authorization and lifecycle

```ts
import { ComputerUseService, createBrowserDriver } from '@wolpertingerlabs/computer-use';

const service = new ComputerUseService({
  targets: [{ id: 'isolated-browser', enabled: true, driver: createBrowserDriver() }],
  authorize: async request => {
    // Lookup CURRENT trusted policy/grant, not model-supplied approval fields.
    // Intersect owner, actor/turn, target, kind, operation, session, generation,
    // expiry and host web/file/code permissions. Unattended ask is not allow.
    return 'deny';
  },
});
```

The immutable authorization request contains `principal`, `operation`, `targetId`, `kind`, and (when known) `sessionId`, `generation`. Allowed operations: `probe | open | observe | act | takeover | resume`. An `Authorizer` returns `allow | deny | ask`; missing, throwing, invalid or timed-out policy denies. `ask` returns typed `approval_required` immediately; it **does not mint a grant**, wait indefinitely, or expose an approval tool. The host can create a pending approval record from the request, resolve it through an authenticated external control plane, then retry with a new action ID. This package does not persist approvals or revocations; hosts requiring durable audit/revocation must persist policy first and invoke `revoke`. No authority is restored after restart.

Identity is bound out of band at `createMcpServer`/`getToolDefinitions`, and copied/frozen at each direct service call. Hosts must authenticate direct callers themselves. Each session has one owner. No model-supplied owner, target switch, role, or approval flag is accepted in action schemas. Status and safety stop/revoke remain available to the authenticated owner under deny. Events are owner-scoped metadata only—no pixels, text, URLs or leases.

Policy is checked at enqueue, dequeue and result delivery, including screenshots. Revocation and stop synchronously bump the generation and abort the current epoch before returning; stale/queued/future calls fail. In-flight real effects cannot be rolled back. Cleanup happens asynchronously, and an uncertain native lock is not released for reuse until the previous operation has settled and cleanup succeeds. Human takeover waits for physical settlement/release before granting input; a stuck operation fails the handoff rather than giving a second controller access. Timeout/cancellation of ordinary input fences the session. Late screenshots are discarded. Already delivered model images cannot be retroactively erased.

Defaults: 30-second operation/policy timeout, queue 16, 15-minute absolute session TTL, 16 active sessions, 10,000 action IDs per session; bounded terminal metadata (1024 records). Duplicate action IDs are rejected, not replayed, including failed attempts. Grants/frames are not cached to disk. Host policy changes should actively call `revoke`; changing a request filter alone does not terminate background network traffic. `stop` means control fencing, not a guarantee that asynchronous cleanup is already complete. `dispose` waits for cleanup; custom drivers must honor their bounded-settlement contract. Browser profiles are ephemeral, isolated per session, persistent across turns while open, deleted on close. No restart/retained-profile recovery or orphan-process reaper is provided in this preview.

## Browser driver

Uses Playwright `chromium.launchPersistentContext` in a private temporary profile, viewport 1280×800, headless by default, device scale 1. Actual PNG screenshots, pointer/keyboard input, navigation and popup-page selection share that context. There is no personal profile import. Browser kind **never** grants desktop access.

Options: `headless`, `executablePath` (trusted operator only), `viewport`, `network`, optional `allowRequest(url)`. Network defaults to `offline`. Select `network: 'unrestricted'` only when the operator explicitly permits broad browser networking, or `'externally-confined'` only when the host provisions its own enforceable OS/proxy boundary. Request filters deny on errors; service workers and WebSockets are blocked, file/non-HTTP(S) routed requests are denied, downloads are disabled/cancelled. These controls **are not an OS firewall or strict filesystem/network sandbox** (DNS, browser internals, WebRTC and arbitrary page/app behavior need external confinement). Do not promise narrow egress/path policy from URL interception. A host with strict web/file restrictions must provision and qualify external confinement or refuse enable; browser mode is not a substitute for native desktop.

The package does not execute page JS/eval. Ordinary website JavaScript still runs. File chooser selection is not exposed. Playwright/Chromium runtime profile writes are necessary infrastructure, not authorization to read/write arbitrary host projects. See [Playwright BrowserContext documentation](https://playwright.dev/docs/api/class-browsercontext) for routing and service-worker limits.

## Native desktop driver: explicit opt-in Linux X11

```ts
const driver = createNativeDesktopDriver({
  enabled: true,
  display: ':0', // Explicit operator selection; never reads ambient DISPLAY as target.
  acknowledgeFullDesktopAccess: true,
  permissions: {
    webAccess: 'allow', fileRead: 'allow', fileWrite: 'allow', codeExecution: 'allow',
  },
});
```

Requires **operator-provisioned** `/usr/bin/xdotool` (libxdo/XTEST, BSD-style upstream license), `/usr/bin/import` (ImageMagick license), and a reachable local X11 display. Nothing is installed. `import -window root png:-` captures actual root-window PNG pixels, with dimensions parsed from the PNG header; xdotool fixed executable/argument vectors implement actual input. No shell process, string command evaluation or model-provided executable is used. Probe checks prerequisites and display geometry, not screenshots/input.

A missing explicit DISPLAY, headless host, disabled/incompatible target, unsupported OS, Wayland/XWayland, or absent commands returns an unavailable `Probe`; `open` throws typed `ComputerUseError('unsupported')`. macOS/Windows/Wayland require an explicitly installed qualified `driver` plugin with native kind and shared lock domain; there are no placeholder-success drivers. The compatibility gate also applies to custom native helpers in this factory.

X11 controls the **full OS desktop**, including terminals and apps able to read/write/network. All four external scopes must therefore be allow and full-desktop effects explicitly acknowledged. An ask/deny scope is rejected, not silently weakened. Pixel/app-name filtering cannot enforce code/file/egress restrictions. Explicitly configured native input has one process-wide lease and a per-user, per-display cross-process lock in the private OS temporary directory. Stale locks are never stolen automatically: after a crash, inspect/release input and remove the stale lock only through operator recovery. This is not a watchdog/helper daemon; a killed process can leave input held. Use an independently supervised qualified helper for stronger crash recovery. Native close releases held input and detaches; it never kills apps or discards unsaved documents. Physical keyboard/mouse activity outside this service cannot be locked out.

Native command choices are based on [upstream xdotool documentation](https://github.com/jordansissel/xdotool/blob/main/xdotool.pod) and [ImageMagick import](https://imagemagick.org/script/import.php). No redistributable native binary is bundled. Prerequisite detection is not live OS/app qualification.

## MCP executable and embedding

```sh
computer-use-mcp                     # No enabled targets; default deny.
computer-use-mcp --config /absolute/trusted-config.mjs
```

The optional file is trusted **operator code**, imported only at startup, exporting `options: ServiceOptions` and optional `principal: Principal`. It must not be writable or chosen by an untrusted model/session. Do not log to stdout in the config; stdout is exclusively MCP. Built-in diagnostics are generic stderr messages without driver errors or screenshot/input contents. An example config can import the library and construct the service options shown above; replace deny with a real external authorizer, never a model-supplied `approved` flag.

`createMcpServer` returns the official SDK `McpServer` so the host chooses stdio or authenticated/in-memory transport. Closing an embedded server does not dispose a shared service. Shutdown ownership belongs to the host. The CLI disposes on EOF/SIGINT/SIGTERM, with a 5-second emergency exit deadline.

One canonical tool surface, from `getToolDefinitions`:

1. `computer_status` — `{ sessionId? }`
2. `computer_probe` — `{ targetId }`
3. `computer_open` — `{ targetId }`
4. `computer_observe` — `{ sessionId, generation }`
5. `computer_act` — `{ sessionId, generation, leaseId, actionId, action }`
6. `computer_stop` — `{ sessionId }`
7. `computer_revoke` — `{ sessionId }`

Definitions are `{ name, description, inputSchema: z.ZodRawShape, handler(input, {signal}?) }`. The server wraps those same handlers with strict Zod schemas. An observation returns **MCP text metadata + a real `{type:'image', data, mimeType}` block**, not base64 in a text placeholder. Errors are sanitized text JSON with `isError: true`. There is no grant/approve/takeover/resume tool, no resource route for cached frames, and no provider/host SDK import. Harness discovery and image-to-model qualification remain integration work; an MCP image test alone does not prove model vision.

## Tests and qualification

```sh
npm test
# Opt in to the existing operator-provisioned Chromium executable for actual smoke:
COMPUTER_USE_TEST_CHROMIUM=/absolute/path/to/chrome npm test
```

The smoke test uses only a disposable isolated browser and local fixture HTTP server. It tests actual pixels, navigation, persistent form state, human input/resume and cross-owner profile isolation. It skips with a reason when no Chromium is provisioned; it never installs browsers. Fake-driver tests cover policy, identity, lease/generation races, queued cancellation, revocation before image delivery, TTL, and native incompatibility. Real MCP in-memory initialize/list/call and actual stdio subprocess discovery are tested. No tests capture/control a live native desktop. Native apps, GPU/Wayland/macOS/Windows, five harness/model vision routes, durable host policy, crash watchdogs and artistic workflows remain **unqualified**.
