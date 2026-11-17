import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import ImageLightbox, { type LightboxItem } from "./ImageLightbox";

/**
 * One gallery per open chat: every image in the transcript, in display order,
 * so the lightbox swipes across messages rather than stopping at the edge of
 * the one that was tapped.
 *
 * Image sites (`ImageThumbnails` in MessageBubble and ToolCallBubble, and
 * MediaRenderer's images) register their element through `useGalleryItem`.
 * The registry is a ref, not state: an image mounting or unmounting never
 * re-renders the transcript, and the context value is created once, so the
 * memoized message bubbles keep their benefit.
 *
 * Order is the DOM's, sorted when the viewer opens — no message-index
 * bookkeeping, and a thumbnail and a rendered image in the same message come
 * out in the order they are drawn. That order is snapshotted for the life of
 * the viewer, so an image streaming in cannot shift the one being looked at.
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
  /** Open the viewer at the image registered for `el`. */
  open(el: HTMLElement): void;
}

const GalleryContext = createContext<GalleryApi | null>(null);

interface GallerySession {
  /** Bumped per open so a second open remounts the viewer at its own start index. */
  id: number;
  items: LightboxItem[];
  startIndex: number;
  returnFocusTo: HTMLElement | null;
}

/** Entries in document order. */
export function sortByDocumentOrder<T extends { el: Node }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

const FOCUSABLE = "button, [href], [tabindex]:not([tabindex='-1'])";

/** The element to return focus to: the focused control inside the image site, else its own first control. */
function focusTarget(el: HTMLElement): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && el.contains(active)) return active;
  if (el.matches(FOCUSABLE)) return el;
  return el.querySelector<HTMLElement>(FOCUSABLE);
}

export function ChatGalleryProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<HTMLElement, GalleryEntry>());
  const nextId = useRef(0);
  const [session, setSession] = useState<GallerySession | null>(null);

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
      open(el) {
        const returnFocusTo = focusTarget(el);
        // The snapshot is taken in the updater, i.e. at the next render — by
        // then every effect of the current commit has run, so an image that
        // opens itself on mount (display_mode: "fullscreen") sees siblings
        // that mounted alongside it.
        setSession((prev) => {
          const sorted = sortByDocumentOrder([...entries.current.values()]);
          const startIndex = sorted.findIndex((e) => e.el === el);
          if (startIndex < 0) return prev;
          return {
            id: ++nextId.current,
            items: sorted.map(({ src, alt, caption, referrerPolicy }) => ({ src, alt, caption, referrerPolicy })),
            startIndex,
            returnFocusTo,
          };
        });
      },
    }),
    [],
  );

  return (
    <GalleryContext.Provider value={api}>
      {children}
      {session && (
        <ImageLightbox
          key={session.id}
          items={session.items}
          startIndex={session.startIndex}
          returnFocusTo={session.returnFocusTo}
          onClose={() => setSession(null)}
        />
      )}
    </GalleryContext.Provider>
  );
}

/** Whether a `ChatGalleryProvider` is above — i.e. images here open the chat-wide viewer. */
export function useHasChatGallery(): boolean {
  return useContext(GalleryContext) !== null;
}

/**
 * Register the element behind `ref` as one image of the chat gallery.
 *
 * Pass `null` for `item` to stay out of it — an image that has not loaded,
 * failed, or is still behind MediaRenderer's untrusted-content gate.
 *
 * Returns the function that opens the gallery at this image, or `null` when
 * there is no `ChatGalleryProvider` above (or `item` is null); callers then
 * fall back to a viewer of their own.
 */
export function useGalleryItem(ref: RefObject<HTMLElement>, item: LightboxItem | null): (() => void) | null {
  const api = useContext(GalleryContext);
  const enabled = item !== null;
  const src = item?.src;
  const alt = item?.alt;
  const caption = item?.caption;
  const referrerPolicy = item?.referrerPolicy;

  useEffect(() => {
    const el = ref.current;
    if (!api || !el || !enabled || src === undefined) return;
    return api.register({ el, src, alt: alt ?? "", caption, referrerPolicy });
  }, [api, ref, enabled, src, alt, caption, referrerPolicy]);

  return useMemo(
    () =>
      api && enabled
        ? () => {
            if (ref.current) api.open(ref.current);
          }
        : null,
    [api, enabled, ref],
  );
}
