# Computer-use viewer HTTP contract

Network and envelope handling lives in `computerUse.ts`. Shared DTOs are in `shared/types/computerUse.ts` and don't import the driver package.

## Endpoints

All paths start with `/api/computer-use/:chatId`. Requests send cookies (`credentials: include`), and POST bodies are JSON. The backend enforces Origin/CSRF, ownership, grants, the human-controller lease and stale frames.

- `GET /status` → `{ capabilities: [{ kind, available, reason?, readiness? }], sessions, permission, events? }`. `events` entries are `{ sessionId, generation, type, at }`.
- `POST /open` with `{ kind: "browser" | "native" }` → `{ session }`. The backend also accepts `"desktop"` and `"native-desktop"` as aliases for `"native"`.
- `POST /:sessionId/observe` with `{}` → `{ frame: { data, mimeType, width, height }, frameId, generation }`. `data` is raw base64 raster bytes, not a URL. Screenshots are never written to localStorage.
- `POST /:sessionId/action` with `{ action, expectedGeneration, frameId, requestId }`. `action` is the shared union: `click`, `move`, `drag`, `scroll`, `key`, `type`, `navigate`. Pointer coordinates are screenshot pixels; the driver handles capture, DPI and native-coordinate transforms. The viewer sends a fresh UUID as `requestId` on every call, but nothing reads it: the server mints its own action ID.
- `POST /:sessionId/takeover|resume|stop|revoke|approve` with `{ expectedGeneration }`. Responses may be JSON or 204, and the viewer refreshes status afterwards. `approve` is an authenticated, session-scoped human decision. There's no endpoint that lets an agent grant itself access.

**Errors** are `{ code, error }`, and the HTTP status comes from `code`:

| `code`                                                                    | Status |
| ------------------------------------------------------------------------- | ------ |
| `not_found`                                                               | 404    |
| `invalid_request`                                                         | 400    |
| `denied`, `approval_required`                                             | 403    |
| `lease_conflict`, `stale_frame`, `stale_generation`, `stopped`, `revoked` | 409    |
| anything else                                                             | 503    |

The client throws the message and attaches `code` to the error (`controlErrorCode`). A `not_found` from stop or revoke is terminal for that session: the server no longer knows it, so it can't be running. The client records it as `closed`, and the emergency Stop ledger stops retrying it.

## Sessions

A session has `id`, `kind`, `state`, `controller` (`"agent" | "human" | null`) and `generation`, plus an optional immutable `targetLabel` and an optional actionable `reason`.

The host emits the package states `starting | ready | stopped | revoked | failed`, plus `pending_approval` for its own generation-zero requests. The viewer groups them like this:

- **Active:** `ready`
- **Waiting:** `pending_approval`
- **Terminal:** `stopped`, `revoked`, `failed`
- **Other:** anything else, including `starting`. Capture and input are disabled.

For other host adapters, the viewer also accepts `active | running` (active), `pending | awaiting_approval | approval_required` (waiting) and `closed | expired` (terminal). Callboard's host never emits these. `state` is typed as `string`, so an unknown value lands in "other" instead of breaking an old client.

## Viewer behaviour

The common Chat page is also the agent-chat destination (both agent dashboard entry points navigate to it), so one viewer integration serves ordinary and agent chats. The Computer view is the panel. The chat header shows a compact status strip with an emergency Stop when:

- the chat has used computer control (`hasUsage`)
- the view is open
- a Stop is in flight or has failed

**Polling.** Status is read once when a chat loads, so stopped history or a pending approval from an earlier visit still shows the strip. After that it polls every 3 seconds, but only while the chat's agent is running, the chat has used computer control, the view is open, or a Stop is in flight. A chat that never used computer control therefore costs one status read and nothing more until its agent runs or the human opens the view. Reopening the view after an idle stretch reads immediately rather than waiting out an interval. Closing the view issues no extra read. Polls never capture screenshots.

**Explicit clicks.** Enable, approve, capture, takeover and resume are each a separate click.

**Manual input.** Input requires human control and the `frameId` from a fresh screenshot in the same generation. Screenshots are cleared on hide, close, control change, error or revoke. Emergency stop and revoke can supersede requests in flight. The action list shows this tab's activity only; it isn't a server audit log.

**Frames.** A `frameId` is a UUID, not a generation or an image label. A missing ID returns 400, and a stale one returns 409. The viewer sends the ID paired with the capture it's showing, then captures again after each action. A capture in another controlling tab supersedes the old frame, and later captures can't revive an old ID. Approval cards keep their exact frame and action snapshot. Asynchronous UI changes can't always be detected, so re-observe after any suspected change.

**Readiness.** Capability availability must reflect server, runtime and engine readiness. On headless or unsupported hosts, native capability must be unavailable, with an actionable reason. The viewer doesn't qualify models or platforms, install browsers or helpers, or substitute the viewer's own machine for the service host.

A native capability may carry an optional `readiness` value: `setup-required`, `unsupported`, `permission-blocked` or `unknown`. This is driver or host metadata; the viewer never derives it from `reason`. Missing or unrecognized values get generic retry guidance. Chat permission restrictions take precedence over the driver's classification, even when a probe throws. Readiness grants nothing: setup guidance is passive, and enabling a target remains a separate human action. Technical details are escaped text in the authenticated viewer, and the package's `operatorDetail` never reaches model-visible probe results.
