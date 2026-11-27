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

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Two live regions that exist before any toast does (a region
          inserted together with its text is often not announced): errors
          are assertive, everything else polite. The toasts themselves carry
          no role, so nothing is announced twice. */}
      <div className="toast-region" role="region" aria-label="Notifications">
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
