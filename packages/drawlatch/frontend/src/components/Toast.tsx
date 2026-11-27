/**
 * Toasts: short confirmations after a mutation succeeds ("Secret saved"),
 * or a failure that has nowhere better to go.
 *
 *   const toast = useToast();
 *   toast.show("Caller created");
 *   toast.show("Couldn't start the listener: …", { kind: "error" });
 *
 * Prefer an inline error next to the control for failures the user must
 * act on; a toast is for news. `<ToastProvider>` is mounted once in App and
 * renders the live region; outside it `useToast()` is a no-op.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

export type ToastKind = "success" | "error" | "info";

export interface ToastOptions {
  /** Default "success". */
  kind?: ToastKind;
  /** Milliseconds on screen. Default 4000, or 8000 for errors. */
  duration?: number;
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  show: (message: ReactNode, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: ReactNode;
  duration: number;
}

const MAX_VISIBLE = 4;

const noop: ToastApi = { show: () => -1, dismiss: () => undefined };
const ToastContext = createContext<ToastApi>(noop);

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((message: ReactNode, options: ToastOptions = {}) => {
    const kind = options.kind ?? "success";
    const id = nextId.current++;
    const duration = options.duration ?? (kind === "error" ? 8000 : 4000);
    setItems((list) => [...list, { id, kind, message, duration }].slice(-MAX_VISIBLE));
    return id;
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  // Phones: the stack sits at the top, below whatever header band is in the
  // way, so it never lands on a control (the top bar's menu button, a
  // full-screen modal's close button). Re-placed when a modal mounts or
  // unmounts (Modal portals into <body>), when the topmost modal's header
  // changes size, and on resize.
  const regionRef = useRef<HTMLDivElement>(null);
  const hasItems = items.length > 0;
  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region || !hasItems) return;
    const phone = window.matchMedia(PHONE_QUERY);
    // A modal header can grow after it mounts (a description rendering in),
    // so the topmost one is watched for size changes too. Only re-targeted
    // when the topmost header changes: observe() fires once on attach.
    let watched: HTMLElement | null = null;
    const headerSize = new ResizeObserver(() => place());
    const place = () => {
      const header = topmostModalHeader();
      if (header !== watched) {
        if (watched) headerSize.unobserve(watched);
        if (header) headerSize.observe(header);
        watched = header;
      }
      if (!phone.matches) {
        region.style.removeProperty("--dl-toast-top");
        return;
      }
      region.style.setProperty("--dl-toast-top", `${toastTop(region.offsetHeight)}px`);
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true });
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      headerSize.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [hasItems, items.length]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Two live regions that exist before any toast does (a region
          inserted together with its text is often not announced): errors
          are assertive, everything else polite. The toasts themselves carry
          no role, so nothing is announced twice. */}
      <div ref={regionRef} className="toast-region" role="region" aria-label="Notifications">
        <div className="toast-stack" aria-live="assertive" aria-atomic="false">
          {items
            .filter((t) => t.kind === "error")
            .map((t) => (
              <ToastView key={t.id} item={t} onDismiss={dismiss} />
            ))}
        </div>
        <div className="toast-stack" aria-live="polite" aria-atomic="false">
          {items
            .filter((t) => t.kind !== "error")
            .map((t) => (
              <ToastView key={t.id} item={t} onDismiss={dismiss} />
            ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

const PHONE_QUERY = "(max-width: 768px)";
const GAP = 8;

/** Where the stack's top goes on a phone: under the top bar, or under the
 *  header of the topmost modal if its panel reaches up into that space (a
 *  full-screen modal, or a tall bottom sheet). */
function toastTop(stackHeight: number): number {
  const bar = document.querySelector<HTMLElement>(".mobile-topbar");
  let top = (bar ? Math.max(bar.getBoundingClientRect().bottom, 0) : 0) + GAP;
  const panel = topmostModalPanel();
  if (panel && panel.getBoundingClientRect().top < top + stackHeight) {
    const header = panel.querySelector<HTMLElement>(".modal-header");
    if (header) top = Math.max(top, header.getBoundingClientRect().bottom + GAP);
  }
  return Math.round(top);
}

function topmostModalPanel(): HTMLElement | null {
  const panels = document.querySelectorAll<HTMLElement>(".modal-overlay .modal-panel");
  return panels[panels.length - 1] ?? null;
}

function topmostModalHeader(): HTMLElement | null {
  return topmostModalPanel()?.querySelector<HTMLElement>(".modal-header") ?? null;
}

const ICONS = { success: CheckCircle2, error: AlertTriangle, info: Info };

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => onDismiss(item.id), item.duration);
    return () => window.clearTimeout(timer);
  }, [item.id, item.duration, onDismiss, paused]);

  const Icon = ICONS[item.kind];
  return (
    <div
      className={`toast toast-${item.kind}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon size={16} className="toast-icon" aria-hidden="true" />
      <div className="toast-message">{item.message}</div>
      <button
        type="button"
        className="toast-close dl-tap-compact"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(item.id)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
