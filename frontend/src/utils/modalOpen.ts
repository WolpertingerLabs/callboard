/**
 * Whether a modal layer is open: a `ModalOverlay` (which carries
 * `data-modal-overlay`), a fullscreen artifact backdrop, or any dialog
 * marked `aria-modal="true"` (the image lightbox, the computer-use expanded
 * view, the compress dialog).
 *
 * For page-level floating UI that must step aside while one is up — the
 * selection quote bar hides and ignores its shortcuts.
 */
export const MODAL_OPEN_SELECTOR = '[data-modal-overlay], [aria-modal="true"]';

export function isModalOpen(doc: Document = document): boolean {
  return doc.querySelector(MODAL_OPEN_SELECTOR) !== null;
}
