# Computer-use viewer HTTP contract

Network/envelope adaptation is isolated in `computerUse.ts`. Shared DTOs are in
`shared/types/computerUse.ts`; they do not import the driver package.

All paths start with `/api/computer-use/:chatId`. Cookies are sent with
`credentials: include`, and POSTs use JSON, matching existing authenticated
frontend calls. The backend owns Origin/CSRF, ownership, grant, human-controller
lease and stale-frame enforcement.

- GET `/status`: `{ capabilities: [{ kind, available, reason?, readiness? }], sessions, permission }`.
- POST `/open`: `{ kind: "browser" | "native" }` → `{ session }`.
- POST `/:sessionId/observe`: `{}` → `{ frame: { data, mimeType, width, height }, frameId, generation }`.
  Data is raw base64 raster bytes, not a URL. Screenshots are never stored in localStorage.
- POST `/:sessionId/action`: `{ action, expectedGeneration, frameId, requestId }`.
  See shared discriminated action union (click, move, drag, scroll, key, type, navigate).
  Pointer coordinates are screenshot pixels; the driver owns capture/DPI/native-coordinate transforms.
- POST `/:sessionId/takeover|resume|stop|revoke|approve`: `{ expectedGeneration }`.
  Action/control responses may be JSON or 204; the viewer refreshes status afterward.
  Approval is an authenticated, session-scoped human decision; no agent grant endpoint is exposed.
- Errors: `{ code, error }` with an HTTP status derived from `code` (`not_found` 404,
  `invalid_request` 400, `denied`/`approval_required` 403, `lease_conflict`/`stale_frame`/
  `stale_generation`/`stopped`/`revoked` 409, otherwise 503). The client throws the
  message and carries `code` on the error (`controlErrorCode`). `not_found` from
  stop/revoke is terminal evidence for that session id: the server no longer knows
  it, so it cannot be running; the client records it as `closed` and the emergency
  ledger stops retrying it.

Session fields: `id, kind, state, controller: "agent" | "human" | null, generation`,
optional immutable `targetLabel`, optional actionable `reason`.
The host emits the package states `starting|ready|stopped|revoked|failed`, plus
`pending_approval` for its own generation-zero target/action requests. The viewer
maps them as: active `ready`; waiting for approval `pending_approval`; terminal
`stopped|revoked|failed`; anything else (including `starting`) is shown as "other"
and disables capture and input. It additionally tolerates the aliases
`active|running` (active), `pending|awaiting_approval|approval_required` (waiting)
and `closed|expired` (terminal) for other host adapters; the host does not emit them.
`shared/types/computerUse.ts` types `state` as `string`, so an unknown value never
breaks an old client — it lands in "other".

The common Chat page is also the agent-chat destination (both agent dashboard
entry points navigate to it), so one viewer integration serves ordinary and agent chats.
The Computer view is the panel; the chat header carries a compact status strip
with an emergency Stop, shown once the chat has used computer control
(`hasUsage`), while the view is open, or while a Stop is in flight or failed.
Status is read once when a chat loads, so stopped history or a pending approval
from an earlier visit still shows the strip. It then polls every 3 seconds only
while at least one of these holds: the chat's agent is running, the chat has used
computer control, the Computer view is open, or a Stop is in flight. A chat that
never used computer control therefore costs one status read and nothing more
until its agent runs or the human opens the view. Reopening the view after an
idle stretch reads immediately rather than waiting out an interval. Closing the
view issues no extra read. No poll ever captures a screenshot.
Enable, approval, screenshot capture, takeover and resume are separate explicit clicks.
Manual input requires human control and the required frameId from a fresh same-generation screenshot;
screenshots clear on hide/close/control changes/error/revoke. Emergency stop/revoke
can supersede in-flight requests. The action list is local tab activity, not a
claim of complete server audit history.

Capability availability must include server/runtime/engine readiness. This UI
does not qualify models or platforms, install browsers/helpers, or substitute
the viewer's machine for a native service-host target. Native availability on
headless or unsupported hosts must be false with an actionable reason.

The frameId is a UUID, not a lease generation or optional image label. Missing IDs return 400; stale IDs return 409. The viewer sends the exact ID paired with its displayed capture, then captures again after an action. A capture in another controlling tab supersedes the prior frame; subsequent captures cannot make an old ID valid again. Approval cards retain their exact frame/action snapshot. External asynchronous UI changes cannot be perfectly detected; re-observation remains necessary after suspected changes.


Native capabilities may include optional `readiness`: `setup-required`,
`unsupported`, `permission-blocked`, or `unknown`. This is driver/host metadata,
never a classification derived from `reason`. Missing or unrecognized values
retain generic retry/check guidance. Chat permission restrictions override
driver classification, including when a probe throws. This metadata grants
nothing: setup guidance is passive, and enabling a target remains a separate
human action. Technical details are escaped text in the authenticated viewer;
package `operatorDetail` remains excluded from model-visible MCP probe results.
