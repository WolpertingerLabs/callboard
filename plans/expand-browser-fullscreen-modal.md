# Expanded browser / desktop viewer investigation

Status: investigation and proposed scope only; no runtime changes implemented.
Inspected checkout: `19618c7`.

## Conclusion

An expanded, viewport-filling modal is feasible as a frontend-only feature for
both managed browser and native desktop sessions. Keep the existing viewer
mounted and display its current, validated screenshot in a watch-only modal.
No new endpoint, transport, dependency, or target permission is needed.

This expands the viewer, not the capture target. The existing live preview is
serialized screenshot polling at approximately 1 fps, not video. The managed
browser defaults to a 1280 × 800 page viewport; enlarging its image does not
increase resolution, capture the whole scrollable page, or show browser chrome.
The shipped native driver captures the service host's configured X11 root
window, not the computer on which the user opens Callboard.

## Current implementation and integration points

- `frontend/src/pages/Chat.tsx`: owns one `useComputerUseController` and mounts
  `ComputerUsePanel` only in the Computer view. Route changes and emergency stop
  invalidate/remount that panel. A modal owned by the panel follows that lifetime.
- `frontend/src/components/ComputerUsePanel.tsx`: renders both target kinds,
  owns preview state and capture scheduling, waits for image load/decode, and
  validates each displayed frame against session identity, generation,
  controller, target, permissions, and availability. Its capture queue also
  serializes accepted observations across panel remounts.
- `frontend/src/components/ComputerUsePanel.css`: fits the image into the space
  remaining after setup, session controls, manual input, and the footer. This
  consumes much of a short viewport. At widths up to 768 px, it deliberately
  switches to a scrolling layout rather than fitting height.
- `frontend/src/components/ComputerUseHeader.tsx`: exposes the shared
  `controller.stopAll()` emergency action, including status/error feedback.
  A modal must not leave this action accessible only behind its backdrop.
- `frontend/src/components/ModalOverlay.tsx`: supplies a fixed backdrop and
  error boundary, but not dialog semantics, a portal, focus containment,
  Escape handling, or focus restoration. These require explicit handling for
  the expanded viewer; visual reuse alone is insufficient.
- `CanvasRenderer.tsx` and `MessageBubble.tsx` have fullscreen presentation
  precedents, but their content/snapshot state should not become a second owner
  of live screenshot data.
- Capture scope and dimensions are established by
  `packages/computer-use/src/drivers/browser.ts` and `native.ts`; neither needs
  modification for expansion.

## Recommended first version

1. Add an accessible **Expand view** button beside the screenshot, available
   once a valid frame exists. Keep it separate from the image's pointer handlers:
   clicking the inline image can already send input after human takeover.
2. Open an edge-to-edge or nearly edge-to-edge modal, with a compact toolbar and
   all remaining space devoted to the image. Preserve aspect ratio and show the
   entire frame; letterboxing is preferable to cropping. Account for mobile
   viewport height and safe areas, and do not inherit the inline mobile
   scrolling-image rules.
3. Show the target identity, explicit **Live (1 fps)** / **Paused** state,
   Live/Pause control, **Stop computer** (the shared all-session stop), and Close.
   Reuse the existing safety header where practical. Keep errors and stop
   failures visible, including when stopping unmounts the panel/modal.
4. Opening and closing only change presentation. Preserve live/paused state;
   do not implicitly enable, approve, take over, resume, refresh, or stop a
   target. In particular, Close must not call `hideScreenshot`, which stops
   preview and discards pixels. Starting Live remains an explicit user action.
5. Make the modal watch-only even during human takeover. Pointer and keyboard
   events on its image must not dispatch computer actions. Leave manual input
   in the inline viewer for this first version.
6. Keep frame ownership, status polling, image readiness, and the capture loop
   in the existing mounted panel/controller. Pass the derived `frame` to a
   presentational modal; store expansion state, not a copied screenshot source.
   Never mount a second `ComputerUsePanel` or controller for expansion.
7. Clear/close expansion on Hide screenshot, invalidated authority, session/chat
   changes, capture failures, and viewer unmount. Do not retain stale pixels or
   automatically reopen after a later refresh. Ordinary live captures should
   continue retaining the previous valid image until its replacement is decoded.
8. Provide a named modal dialog, initial focus, keyboard focus containment,
   Escape dismissal, background interaction suppression, and focus restoration
   to Expand when it still exists. Mount outside the chat's clipped layout
   using a portal or a native modal dialog. No browser Fullscreen API is needed
   to fill the application's viewport.

## Expected change surface

- `ComputerUsePanel.tsx`: expansion state, trigger, modal wiring, invalidation.
- A small presentational expanded-view component with scoped CSS and modal
  lifecycle/accessibility handling. Keep the capture/control machinery out of it.
- Focused additions to `ComputerUsePanel.test.tsx`,
  `ComputerUsePanel.layout.test.tsx`, and `Chat.computerView.test.tsx`, plus
  modal-specific tests if the component is extracted.
- No planned changes to drivers, shared DTOs, HTTP routes, or the controller's
  capture/authority behavior. Avoid broad changes to every existing modal.

## Acceptance and regression checks

- Browser and native frames both expand, retain aspect ratio, and fully fit on
  desktop, short laptop, portrait phone, and landscape phone viewports.
- Successive decoded frames update the open modal. Opening/closing adds no
  capture or status poll and does not restart the panel or change permissions.
- A paused screenshot stays paused across expand/collapse; live preview continues
  across both transitions. Paused pixels are not labelled live.
- Pending capture/load/decode retains valid old pixels without flicker. Hide,
  stop/revoke, status/permission failure, session changes, and navigation clear
  pixels; late completions cannot repopulate a closed/invalidated viewer.
- Modal image clicks, drags, and keys never call `client.action`, including
  during human takeover. Close/Escape never call control endpoints.
- Emergency Stop remains reachable and immediate during a held capture, covers
  all sessions, and exposes failures/retry through the shared controller/header.
- Keyboard open/close, Tab containment, accessible naming, background isolation,
  and focus restoration work. No second modal survives route/view changes.
- Validate actual geometry and hit targets in a real browser; the existing
  jsdom layout tests explicitly cannot prove image fit or detect overlap.

## Validation performed

Read-only source and existing regression-test review. No desktop/browser target
was enabled or captured. Runtime tests were not run: this checkout has no
installed `node_modules`. Implementation and real-browser verification remain
future work.
