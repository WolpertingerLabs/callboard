/**
 * Modal: the one dialog shell. Every overlay in the dashboard should render
 * through this instead of its own overlay/panel/header CSS.
 *
 * What it does for you:
 * - Portals to <body>, labels itself with the title (`aria-labelledby`) and
 *   sets `aria-modal`.
 * - Moves focus in on open (`initialFocusRef`, else the first field or
 *   button in the body, else the panel), traps Tab inside, and gives focus
 *   back to whatever had it on close.
 * - Escape closes only the topmost modal, and doesn't reach window-level
 *   Escape handlers underneath (a ConfirmDialog over a legacy panel closes
 *   just the dialog).
 * - A backdrop click closes only if the press both started and ended on the
 *   backdrop (dragging a text selection out of a field, or into the panel,
 *   doesn't close it).
 * - Locks body scroll while open, and becomes a full-screen sheet at ≤768px
 *   (`size="sm"` becomes a bottom sheet).
 *
 * Events: the modal is portaled, but React still bubbles its events to the
 * component that rendered it. The overlay stops `click`, `submit` and
 * `keydown` there, so Enter on a button inside can't trigger a clickable
 * row's onKeyDown, and a form inside can't submit an outer form. Because a
 * React stopPropagation also stops the native event at <body>, document-
 * and window-level click/keydown listeners never see events from inside a
 * modal. Close a popover inside a modal from a `mousedown` listener (not
 * stopped) or one on the panel, not a document `click` listener.
 *
 * Focus on close goes to `returnFocusRef` if given and still in the page,
 * else to whatever had focus at open, else (when that element is gone, or
 * is removed within a few seconds, as when a delete refetches the list the
 * trigger was in) to the page's <h1>.
 *
 * Closing rules:
 * - `busy`: nothing closes it, and × is disabled (a request is in flight).
 * - `dismissible={false}`: the backdrop doesn't close it; Escape and × still
 *   call `onClose`, so the owner can ask "Discard changes?" there. Use it
 *   while a form is dirty or on a view that is shown only once.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  /** Called on Escape, ×, and (when dismissible) a backdrop click. */
  onClose: () => void;
  /** Default true. False: the backdrop no longer closes it. */
  dismissible?: boolean;
  /** Default "md" (560px). "sm" is 440px, "lg" 760px. */
  size?: "sm" | "md" | "lg";
  /** Rendered in the footer bar, right-aligned. Omit for no footer. */
  footer?: ReactNode;
  /** Element to focus on open. Defaults to the first field or button. */
  initialFocusRef?: RefObject<HTMLElement>;
  children?: ReactNode;
  /** Small line under the title (caller alias, item name). */
  subtitle?: ReactNode;
  /** Icon shown before the title, in a tinted square. */
  icon?: ReactNode;
  iconTone?: "accent" | "danger";
  /** "alertdialog" for confirmations of destructive actions. */
  role?: "dialog" | "alertdialog";
  /** A request is in flight: nothing closes the modal and × is disabled. */
  busy?: boolean;
  /** Id of the element that describes the dialog (`aria-describedby`). */
  describedBy?: string;
  /** Force the stacked z-index (a dialog opened from inside another one).
   *  Set automatically when another Modal is already open. */
  nested?: boolean;
  /** Extra class on the panel. */
  className?: string;
  /** Extra class on the scrolling body. */
  bodyClassName?: string;
  /** Hide the × button (the footer has the only way out). */
  hideClose?: boolean;
  /** Where focus goes on close. Default: the element focused at open, or
   *  the page heading if that element has been removed. */
  returnFocusRef?: RefObject<HTMLElement>;
}

// Open modals, oldest first. Only the last one handles Escape and Tab.
const stack: string[] = [];
let scrollLocks = 0;
let savedOverflow = "";

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0 && !el.closest("[inert]"),
  );
}

/**
 * Sequential-focus stops in `root`, the way the browser's Tab sees them:
 * no tabindex="-1", nothing disabled, hidden or inert, and one stop per
 * radio group (its checked radio, or the first one if none is checked).
 * Only used to find the first and last stops; the browser moves focus
 * between them itself.
 */
function tabStops(root: HTMLElement): HTMLElement[] {
  const seenGroups = new Set<string>();
  const out: HTMLElement[] = [];
  for (const el of focusables(root)) {
    if (el.tabIndex < 0) continue;
    if (getComputedStyle(el).visibility === "hidden") continue;
    if (el instanceof HTMLInputElement && el.type === "radio" && el.name) {
      const key = radioGroupKey(el);
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
      const group = radioGroup(el, root);
      out.push(group.find((r) => r.checked) ?? group[0]);
      continue;
    }
    out.push(el);
  }
  return out;
}

function radioGroupKey(el: HTMLInputElement): string {
  return `${el.form ? el.form.id || "form" : ""}::${el.name}`;
}

function radioGroup(el: HTMLInputElement, root: HTMLElement): HTMLInputElement[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter(
    (r) => r.name === el.name && r.form === el.form && !r.disabled && r.getClientRects().length > 0,
  );
}

/** Same Tab stop: the same element, or two radios of one group. */
function sameStop(a: Element, b: Element): boolean {
  if (a === b) return true;
  return (
    a instanceof HTMLInputElement &&
    b instanceof HTMLInputElement &&
    a.type === "radio" &&
    b.type === "radio" &&
    a.name !== "" &&
    a.name === b.name &&
    a.form === b.form
  );
}

function restoreFocus(
  preferred: HTMLElement | null,
  previous: HTMLElement | null,
  self: HTMLElement | null,
): void {
  for (const el of [preferred, previous]) {
    if (el && el.isConnected && !(self && self.contains(el))) {
      el.focus({ preventScroll: true });
      if (document.activeElement === el) {
        // The usual delete flow closes the dialog, then refetches and drops
        // the row the trigger was on. If that takes focus with it, recover.
        watchForRemoval(el);
        return;
      }
    }
  }
  focusFallback(self);
}

/** The trigger is gone: stay in the next modal up, else the page heading. */
function focusFallback(self: HTMLElement | null): void {
  const panels = Array.from(
    document.querySelectorAll<HTMLElement>(".modal-overlay .modal-panel"),
  ).filter((p) => p !== self);
  if (stack.length > 0 && panels.length > 0) {
    panels[panels.length - 1].focus({ preventScroll: true });
    return;
  }
  const heading = document.querySelector<HTMLElement>(".main-content h1");
  if (heading) {
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }
}

const REMOVAL_WATCH_MS = 5_000;

function watchForRemoval(el: HTMLElement): void {
  if (typeof MutationObserver === "undefined") return;
  const observer = new MutationObserver(() => {
    if (el.isConnected) return;
    stop();
    const active = document.activeElement;
    if (!active || active === document.body) focusFallback(null);
  });
  const timer = window.setTimeout(() => stop(), REMOVAL_WATCH_MS);
  const stop = () => {
    observer.disconnect();
    window.clearTimeout(timer);
  };
  observer.observe(document.body, { childList: true, subtree: true });
}

export default function Modal(props: ModalProps) {
  if (!props.open) return null;
  return <OpenModal {...props} />;
}

function OpenModal({
  title,
  onClose,
  dismissible = true,
  size = "md",
  footer,
  initialFocusRef,
  children,
  subtitle,
  icon,
  iconTone = "accent",
  role = "dialog",
  busy = false,
  describedBy,
  nested,
  className,
  bodyClassName,
  hideClose = false,
  returnFocusRef,
}: ModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const downOnBackdrop = useRef(false);
  const upOnBackdrop = useRef(false);
  // Read the latest props from the document listener without re-binding it.
  const latest = useRef({ onClose, busy, returnFocusRef });
  latest.current = { onClose, busy, returnFocusRef };
  // Decided once, at open: was another modal already up?
  const depthRef = useRef<number | null>(null);
  if (depthRef.current === null) depthRef.current = stack.length;
  const isNested = nested ?? depthRef.current > 0;

  // Register on the stack, lock scroll, and restore focus on close.
  useLayoutEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const self = panelRef.current;
    stack.push(id);
    if (scrollLocks++ === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    return () => {
      const i = stack.lastIndexOf(id);
      if (i !== -1) stack.splice(i, 1);
      if (--scrollLocks === 0) document.body.style.overflow = savedOverflow;
      restoreFocus(
        latest.current.returnFocusRef?.current ?? null,
        previouslyFocused,
        self,
      );
    };
  }, [id]);

  // Initial focus.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const target =
      initialFocusRef?.current ??
      (bodyRef.current ? focusables(bodyRef.current)[0] : undefined) ??
      (footer ? focusables(panel).find((el) => !el.closest(".modal-header")) : undefined) ??
      panel;
    target.focus({ preventScroll: true });
    // Only on open: later prop changes must not steal focus back.
  }, []);

  // Escape and the Tab trap, for the topmost modal only. Returns true when
  // it handled the key. A field inside that handles Escape itself (calling
  // preventDefault, or stopPropagation so it never gets here) wins.
  const handleKey = (e: {
    key: string;
    shiftKey: boolean;
    defaultPrevented: boolean;
    preventDefault: () => void;
  }): boolean => {
    if (stack[stack.length - 1] !== id) return false;
    const panel = panelRef.current;
    if (!panel) return false;
    if (e.key === "Escape") {
      if (e.defaultPrevented) return false;
      e.preventDefault();
      if (!latest.current.busy) latest.current.onClose();
      return true;
    }
    if (e.key !== "Tab") return false;
    // Only step in when focus would leave the dialog; between the first and
    // last stops the browser's own order applies (radio groups are one stop,
    // tabindex="-1" is skipped, and so on).
    const stops = tabStops(panel);
    if (stops.length === 0) {
      e.preventDefault();
      panel.focus();
      return true;
    }
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    const wrapTo = (el: HTMLElement) => {
      e.preventDefault();
      el.focus();
      return true;
    };
    if (!(active instanceof HTMLElement) || !panel.contains(active)) {
      return wrapTo(e.shiftKey ? last : first);
    }
    // Is there a stop after (or before) the focused element, not counting
    // the radio group it belongs to? If not, the browser would leave the
    // dialog. This also covers focus on the panel itself or on a
    // tabindex="-1" element after the last stop.
    const others = stops.filter((s) => !sameStop(s, active));
    if (e.shiftKey) {
      const hasBefore =
        !sameStop(active, first) &&
        others.some((s) => s.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING);
      return hasBefore ? false : wrapTo(last);
    }
    const hasAfter =
      !sameStop(active, last) &&
      others.some((s) => active.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING);
    return hasAfter ? false : wrapTo(first);
  };
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;

  // Keys from inside the modal are handled by the overlay's onKeyDown below
  // (which also stops them). This catches the rest: focus left on <body>
  // after a click on a non-dismissible backdrop, say.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const overlay = overlayRef.current;
      if (overlay && e.target instanceof Node && overlay.contains(e.target)) return;
      if (handleKeyRef.current(e)) e.stopPropagation();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const overlayClass = [
    "modal-overlay",
    isNested ? "is-nested" : "",
    size === "sm" ? "is-sheet-sm" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const panelClass = [
    "modal-panel",
    `modal-${size}`,
    footer ? "has-footer" : "no-footer",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return createPortal(
    <div
      ref={overlayRef}
      className={overlayClass}
      role="presentation"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
        upOnBackdrop.current = false;
      }}
      onMouseUp={(e) => {
        upOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Keep clicks from reaching React ancestors of the component that
        // rendered the modal (a clickable table row, say).
        e.stopPropagation();
        // Both ends of the press on the backdrop: a drag from the panel out,
        // or from the backdrop in, is not a backdrop click.
        const onBackdrop =
          downOnBackdrop.current && upOnBackdrop.current && e.target === e.currentTarget;
        downOnBackdrop.current = false;
        upOnBackdrop.current = false;
        if (onBackdrop && dismissible && !busy) onClose();
      }}
      onKeyDown={(e) => {
        handleKey(e);
        // Not to React ancestors (a row's Enter-to-open), and not to window
        // listeners of a legacy panel underneath.
        e.stopPropagation();
      }}
      onSubmit={(e) => {
        // A form inside must not also submit a form around the modal.
        e.stopPropagation();
      }}
    >
      <div
        ref={panelRef}
        className={panelClass}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div className="modal-header-text">
            {icon && (
              <span
                className={`modal-icon${iconTone === "danger" ? " modal-icon-danger" : ""}`}
                aria-hidden="true"
              >
                {icon}
              </span>
            )}
            <div style={{ minWidth: 0 }}>
              <h2 id={titleId} className="modal-title">
                {title}
              </h2>
              {subtitle && <div className="modal-subtitle">{subtitle}</div>}
            </div>
          </div>
          {!hideClose && (
            <button
              type="button"
              className="modal-close"
              aria-label="Close"
              title="Close"
              disabled={busy}
              onClick={onClose}
            >
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </div>
        <div ref={bodyRef} className={`modal-body${bodyClassName ? ` ${bodyClassName}` : ""}`}>
          {children}
        </div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
