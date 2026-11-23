import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import ImageLightbox, { type LightboxItem } from "./ImageLightbox";

/**
 * One gallery per open chat: every image and rendered video in the
 * transcript, in display order, so the lightbox swipes across messages rather
 * than stopping at the edge of the one that was tapped.
 *
 * Image sites (`ImageThumbnails` in MessageBubble and ToolCallBubble, and
 * MediaRenderer's images and videos) register their element through `useGalleryItem`.
 * The registry is a ref, not state: an image mounting or unmounting never
 * re-renders the transcript, and the context value is created once, so the
 * memoized message bubbles keep their benefit.
 *
 * Order is the DOM's, sorted when the viewer opens — no message-index
 * bookkeeping, and a thumbnail and a rendered image in the same message come
 * out in the order they are drawn. That order is snapshotted for the life of
 * the viewer, so an image streaming in cannot shift the one being looked at,
 * and an auto-opening (display_mode: "fullscreen") image that streams in
 * while the viewer is open does not take it over.
 *
 * Only mounted images take part. The transcript is not virtualized today; if
 * it ever is, images scrolled out of the DOM will simply be absent from the
 * gallery until they mount again.
 */

interface GalleryEntry extends LightboxItem {
  el: HTMLElement;
}

interface GalleryApi {
  /** Add an image; returns its unregister function. */
  register(entry: GalleryEntry): () => void;
  /**
   * Open the viewer at the image registered for `el`. `auto` marks an open
   * nobody tapped for (display_mode: "fullscreen"): it yields to a viewer that
   * is already open, and returns focus nowhere on close.
   */
  open(el: HTMLElement, opts?: { auto?: boolean }): void;
}

const GalleryContext = createContext<GalleryApi | null>(null);

interface GallerySession {
  /** Bumped per open so a second open remounts the viewer at its own start index. */
  id: number;
  /** The image the viewer opens at. */
  el: HTMLElement;
  /**
   * The snapshot, or null while the open is still a request: the list is
   * built in a later commit than the one that asked for it (see below).
   */
  items: LightboxItem[] | null;
  startIndex: number;
  /** See `ImageLightbox`'s prop: undefined restores to what was focused, null to nothing. */
  returnFocusTo: HTMLElement | null | undefined;
}

/** Entries in document order. */
export function sortByDocumentOrder<T extends { el: Node }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

const FOCUSABLE = "button, [href], [tabindex]:not([tabindex='-1'])";

/**
 * The element to return focus to: the focused control inside the image site,
 * else its own first control, else (undefined) whatever was focused.
 */
function focusTarget(el: HTMLElement): HTMLElement | undefined {
  const active = document.activeElement;
  if (active instanceof HTMLElement && el.contains(active)) return active;
  if (el.matches(FOCUSABLE)) return el;
  return el.querySelector<HTMLElement>(FOCUSABLE) ?? undefined;
}

export function ChatGalleryProvider({ children, resetKey }: { children: ReactNode; resetKey?: unknown }) {
  const entries = useRef(new Map<HTMLElement, GalleryEntry>());
  const nextId = useRef(0);
  const [session, setSession] = useState<GallerySession | null>(null);
  /** Whether a viewer is showing, for `open` (which must stay stable) to read. */
  const viewerOpen = useRef(false);
  useLayoutEffect(() => {
    viewerOpen.current = !!session?.items;
  });

  // The provider outlives a chat switch (the page reuses one Chat instance
  // across /chat/:id), so the open viewer — still showing the old chat's
  // images — is closed when the chat changes. Adjusted during render rather
  // than in an effect so the old viewer is never painted over the new chat.
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    setSession(null);
  }

  // Build the snapshot one commit after the request. An image that opens
  // itself on mount does so from its own mount effect, before the effects of
  // the images after it have registered them; React may also run a state
  // updater eagerly at the setState call, so the list can't be taken there
  // either. By this layout effect every image of the requesting commit is in
  // `entries`, and it runs before paint, so a tap still opens in one frame.
  useLayoutEffect(() => {
    if (!session || session.items) return;
    // An image removed in the requesting commit is still registered here:
    // React runs a deleted component's passive cleanup (the unregister) after
    // this layout effect. Its element is already detached, though — skip it,
    // or it becomes a ghost slide at an arbitrary position.
    const sorted = sortByDocumentOrder([...entries.current.values()].filter((e) => e.el.isConnected));
    const startIndex = sorted.findIndex((e) => e.el === session.el);
    setSession(
      startIndex < 0
        ? null
        : {
            ...session,
            startIndex,
            items: sorted.map(({ el, src, alt, caption, referrerPolicy, kind, poster }) => ({
              src,
              alt,
              caption,
              referrerPolicy,
              kind,
              poster,
              // The slide picks up where the inline copy was; play state is not carried.
              startTime: kind === "video" ? el.querySelector("video")?.currentTime || undefined : undefined,
            })),
          },
    );
  }, [session]);

  // Stable, with the viewer memoized: the transcript re-renders per streamed
  // token, and that must not re-render an open viewer mid-pinch.
  const close = useCallback(() => setSession(null), []);

  /**
   * The viewer plays its own copy of each video: pause every inline one, not
   * just the opened item's, so two never play at once. Run on open and
   * whenever a video slide becomes current.
   */
  const pauseInlineVideos = useCallback(() => {
    entries.current.forEach(({ el }) => el.querySelectorAll("video").forEach((v) => v.pause()));
  }, []);

  const api = useMemo<GalleryApi>(
    () => ({
      register(entry) {
        entries.current.set(entry.el, entry);
        return () => {
          // A re-registration for the same element (changed src) replaced
          // this entry already; don't remove its successor.
          if (entries.current.get(entry.el) === entry) entries.current.delete(entry.el);
        };
      },
      open(el, opts) {
        const auto = !!opts?.auto;
        // An auto-open yields to a viewer already showing — and then pauses nothing.
        if (auto && viewerOpen.current) return;
        pauseInlineVideos();
        // An auto-open restores focus nowhere: what was focused is usually the
        // composer, and focusing it on close would pop the phone keyboard.
        const returnFocusTo = auto ? null : focusTarget(el);
        const id = ++nextId.current;
        setSession((prev) => (auto && prev?.items ? prev : { id, el, items: null, startIndex: 0, returnFocusTo }));
      },
    }),
    [pauseInlineVideos],
  );

  return (
    <GalleryContext.Provider value={api}>
      {children}
      {session?.items && (
        <ImageLightbox
          key={session.id}
          items={session.items}
          startIndex={session.startIndex}
          returnFocusTo={session.returnFocusTo}
          onClose={close}
          onVideoShown={pauseInlineVideos}
        />
      )}
    </GalleryContext.Provider>
  );
}

/** Whether a `ChatGalleryProvider` is above — i.e. images and videos here open the chat-wide viewer. */
export function useHasChatGallery(): boolean {
  return useContext(GalleryContext) !== null;
}

/**
 * Register the element behind `ref` as one image of the chat gallery.
 *
 * Pass `null` for `item` to stay out of it — an image that failed to load, or
 * is still behind MediaRenderer's untrusted-content gate. An image that is
 * still loading registers: the viewer loads it itself.
 *
 * Returns the function that opens the gallery at this image (`"auto"` for an
 * open nobody tapped for — see `GalleryApi.open`), or `null` when there is no
 * `ChatGalleryProvider` above (or `item` is null); callers then fall back to a
 * viewer of their own.
 */
export function useGalleryItem(ref: RefObject<HTMLElement>, item: LightboxItem | null): ((mode?: "auto") => void) | null {
  const api = useContext(GalleryContext);
  const enabled = item !== null;
  const src = item?.src;
  const alt = item?.alt;
  const caption = item?.caption;
  const referrerPolicy = item?.referrerPolicy;
  const kind = item?.kind;
  const poster = item?.poster;

  useEffect(() => {
    const el = ref.current;
    if (!api || !el || !enabled || src === undefined) return;
    return api.register({ el, src, alt: alt ?? "", caption, referrerPolicy, kind, poster });
  }, [api, ref, enabled, src, alt, caption, referrerPolicy, kind, poster]);

  return useMemo(
    () =>
      api && enabled
        ? (mode?: "auto") => {
            if (ref.current) api.open(ref.current, { auto: mode === "auto" });
          }
        : null,
    [api, enabled, ref],
  );
}
