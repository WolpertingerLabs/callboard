# Computer-use viewer HTTP contract

Network/envelope adaptation is isolated in `computerUse.ts`. Shared DTOs are in
`shared/types/computerUse.ts`; they do not import the driver package.

All paths start with `/api/computer-use/:chatId`. Cookies are sent with
`credentials: include`, and POSTs use JSON, matching existing authenticated
frontend calls. The backend owns Origin/CSRF, ownership, grant, human-controller
lease and stale-frame enforcement.

- GET `/status`: `{ capabilities: [{ kind, available, reason? }], sessions, permission }`.
- POST `/open`: `{ kind: "browser" | "native" }` → `{ session }`.
- POST `/:sessionId/observe`: `{}` → `{ frame: { data, mimeType, width, height, id? }, generation }`.
  Data is raw base64 raster bytes, not a URL. Screenshots are never stored in localStorage.
- POST `/:sessionId/action`: `{ action, expectedGeneration, frameId?, requestId }`.
  See shared discriminated action union (click, move, drag, scroll, key, type, navigate).
  Pointer coordinates are screenshot pixels; the driver owns capture/DPI/native-coordinate transforms.
- POST `/:sessionId/takeover|resume|stop|revoke|approve`: `{ expectedGeneration }`.
  Action/control responses may be JSON or 204; the viewer refreshes status afterward.
  Approval is an authenticated, session-scoped human decision; no agent grant endpoint is exposed.

Session fields: `id, kind, state, controller: "agent" | "human" | null, generation`,
optional immutable `targetLabel`, optional actionable `reason`.
The viewer recognizes active states `active|ready|running`; pending approval states
`pending|awaiting_approval|approval_required|pending_approval`; terminal states
`stopped|revoked|closed|failed|expired`. Unknown states disable capture/input.
The host adapter should map package states here as needed.

The common Chat page is also the agent-chat destination (both agent dashboard
entry points navigate to it), so one viewer integration serves ordinary and agent chats.
The collapsed panel makes no requests. Expanding reads status only. Enable,
approval, screenshot capture, takeover and resume are separate explicit clicks.
While expanded, status refreshes every 3 seconds, without automatic captures.
Manual input requires human control and a fresh same-generation screenshot;
screenshots clear on hide/close/control changes/error/revoke. Emergency stop/revoke
can supersede in-flight requests. The action list is local tab activity, not a
claim of complete server audit history.

Capability availability must include server/runtime/engine readiness. This UI
does not qualify models or platforms, install browsers/helpers, or substitute
the viewer's machine for a native service-host target. Native availability on
headless or unsupported hosts must be false with an actionable reason.
