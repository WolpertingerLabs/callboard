/**
 * Whether a modal layer is open: a `ModalOverlay` (which carries
 * `data-modal-overlay`), a fullscreen artifact backdrop, or any dialog
 * marked `aria-modal="true"` (the image lightbox, the computer-use expanded
 * view, the compress dialog).
 *
 * For page-level floating UI that must step aside while one is up — the
 * selection quote bar hides and ignores its shortcuts.
 *
 * The aside panel's mobile sheet is `aria-modal` for assistive tech, but it
 * hosts a whole chat — its own quote bar included — so it is not one of these.
 */
export const MODAL_OPEN_SELECTOR = '[data-modal-overlay], [aria-modal="true"]:not([data-aside-panel])';

export function isModalOpen(doc: Document = document): boolean {
  return doc.querySelector(MODAL_OPEN_SELECTOR) !== null;
}
