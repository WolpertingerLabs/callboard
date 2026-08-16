/**
 * jsdom 25 ships no `PointerEvent`, and the gap fails SILENTLY.
 *
 * `fireEvent.pointerDown(el, { pointerType: "touch", clientX: 10 })` still
 * reaches the handler — testing-library falls back to a plain `Event` — but
 * every init property is dropped, so the handler sees
 * `pointerType === undefined` and `clientX === undefined`.
 *
 * That silence is the danger. A movement threshold written the obvious way,
 * `Math.abs(e.clientX - startX) > moveTolerance`, evaluates `NaN > 10` →
 * `false` in every test. "Scrolling cancels the long press" then fails looking
 * like a logic bug, and — far worse — "small movement does NOT cancel" PASSES
 * for entirely the wrong reason: satisfied by the coordinates being absent
 * rather than by the threshold under test.
 *
 * jsdom's `MouseEvent` already carries `clientX`/`clientY` and the modifier
 * keys, so subclassing it and layering the two pointer-specific fields on top
 * is enough to make the whole gesture path genuinely testable.
 *
 * `useLongPress.test.tsx` asserts this shim is live before it asserts anything
 * about thresholds — without that guard a green coordinate test proves nothing.
 */
class PointerEventShim extends MouseEvent {
  pointerType: string;
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "mouse";
    this.pointerId = init.pointerId ?? 1;
  }
}

if (typeof globalThis.PointerEvent === "undefined") {
  globalThis.PointerEvent = PointerEventShim as unknown as typeof PointerEvent;
}
