import { beforeEach } from "vitest";

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
 * keys, so subclassing it and layering the pointer-specific fields on top
 * is enough to make the whole gesture path genuinely testable. (`isPrimary`
 * too: the image lightbox resets leaked pointers on a primary pointerdown.)
 *
 * `useLongPress.test.tsx` asserts this shim is live before it asserts anything
 * about thresholds — without that guard a green coordinate test proves nothing.
 */
class PointerEventShim extends MouseEvent {
  pointerType: string;
  pointerId: number;
  isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "mouse";
    this.pointerId = init.pointerId ?? 1;
    // False unless asked for, as in the real constructor.
    this.isPrimary = init.isPrimary ?? false;
  }
}

if (typeof globalThis.PointerEvent === "undefined") {
  globalThis.PointerEvent = PointerEventShim as unknown as typeof PointerEvent;
}

/**
 * jsdom 25's `Blob` has `size`, `type` and `slice()` but none of the read
 * methods (`text()`, `arrayBuffer()`, `bytes()`) that every browser has.
 *
 * Up to Node 24 nobody noticed: the global `Response` is undici's, and undici 6
 * built `res.blob()` from Node's own `Blob`, which has them. Node 26 bundles
 * undici 8, which builds it from whatever `globalThis.Blob` is at call time —
 * under jsdom, jsdom's Blob. So `(await res.blob()).text()` throws
 * "text is not a function" on Node 26 only, and code that is correct in every
 * browser fails its tests (StorageSettings' text preview did exactly this).
 *
 * Fill the gap the way a browser would read a Blob: through jsdom's own
 * `FileReader`, which reads jsdom Blobs. Guarded, so it steps aside once jsdom
 * ships the methods itself.
 */
function readBlob<T>(blob: Blob, read: (r: FileReader) => void, result: (r: FileReader) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(result(reader));
    reader.onerror = () => reject(reader.error);
    read(reader);
  });
}

if (typeof Blob !== "undefined" && typeof FileReader !== "undefined") {
  const proto = Blob.prototype as Partial<Blob>;
  if (typeof proto.text !== "function") {
    // Not FileReader.readAsText: that sniffs a UTF-16 BOM, but Blob.text()
    // always decodes UTF-8 (TextDecoder strips a UTF-8 BOM, as the spec does).
    proto.text = function (this: Blob) {
      return this.arrayBuffer().then((buf) => new TextDecoder().decode(buf));
    };
  }
  if (typeof proto.arrayBuffer !== "function") {
    proto.arrayBuffer = function (this: Blob) {
      return readBlob(
        this,
        (r) => r.readAsArrayBuffer(this),
        (r) => r.result as ArrayBuffer,
      );
    };
  }
  if (typeof proto.bytes !== "function") {
    proto.bytes = function (this: Blob) {
      return this.arrayBuffer().then((buf) => new Uint8Array(buf));
    };
  }
}

/**
 * The composer keeps unsent text in localStorage per chat, and flushes it when
 * it unmounts — so a test that types and then unmounts leaves its text for the
 * next test's composer to restore. Every test starts with no composer drafts.
 */
beforeEach(() => {
  if (typeof localStorage !== "undefined") localStorage.removeItem("callboard-composer-drafts");
});
