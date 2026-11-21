/**
 * Reveal a vault item: a ConfirmDialog, then the values in masked fields
 * with show and copy buttons.
 *
 * The revealed values are held ONLY in this component's state: never in a
 * shared cache, context, URL, or storage. They are cleared when the panel is
 * closed, after REVEAL_TTL_MS, and on any route change (including a change
 * of `?caller=`). Unmounting drops them too.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Check, Copy, Eye, EyeOff, X } from "lucide-react";
import type { AdminVaultItem } from "drawlatch-admin-types";
import { api } from "../../api";
import ConfirmDialog from "../ConfirmDialog";
import "../ConfigureConnectionModal.css";

export const REVEAL_TTL_MS = 60_000;

interface Props {
  caller: string;
  item: AdminVaultItem;
  onClose: () => void;
}

export default function RevealFlow({ caller, item, onClose }: Props) {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_TTL_MS / 1000);
  const location = useLocation();
  const openedAt = useRef(location.key);

  const close = () => {
    setValues(null);
    onClose();
  };

  // Route change (including ?caller=) → clear and close.
  useEffect(() => {
    if (location.key !== openedAt.current) {
      setValues(null);
      onClose();
    }
  }, [location.key, onClose]);

  // 60 s after the values arrive → clear and close.
  useEffect(() => {
    if (values === null) return;
    const started = Date.now();
    const tick = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((REVEAL_TTL_MS - (Date.now() - started)) / 1000));
      setSecondsLeft(left);
    }, 1000);
    const expire = window.setTimeout(() => {
      setValues(null);
      onClose();
    }, REVEAL_TTL_MS);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(expire);
    };
    // Only when the values first arrive (null → object).
  }, [values === null]);

  // Escape closes the value panel (ConfirmDialog handles its own).
  useEffect(() => {
    if (values === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const reveal = async () => {
    setBusy(true);
    setError(null);
    const res = await api.vaultReveal(caller, item.name);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const data = res.data;
    setValues("values" in data ? { ...data.values } : { [data.field]: data.value });
  };

  if (values === null) {
    return (
      <ConfirmDialog
        title={`Reveal "${item.name}"?`}
        confirmLabel="Reveal"
        description={
          <>
            This shows the value on screen and is recorded in{" "}
            <code>{caller}</code>&apos;s audit log. It stays visible for at most
            60 seconds.
          </>
        }
        busy={busy}
        error={error}
        onConfirm={reveal}
        onCancel={close}
      />
    );
  }

  return (
    <div className="dl-secrets-overlay" role="presentation" onClick={close}>
      <div
        className="dl-secrets-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Revealed ${item.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dl-secrets-header">
          <div style={{ minWidth: 0 }}>
            <h2 className="dl-secrets-title">{item.name}</h2>
            <div className="dl-secrets-alias">
              <span className="mono dl-secrets-pill">{caller}</span> · clears in{" "}
              {secondsLeft}s
            </div>
          </div>
          <button
            type="button"
            className="dl-secrets-close"
            onClick={close}
            aria-label="Close"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="dl-secrets-body">
          <div className="dl-secrets-fields">
            {Object.entries(values)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([field, value]) => (
                <RevealedField key={field} field={field} value={value} />
              ))}
          </div>
        </div>
        <div className="dl-secrets-footer">
          <div className="dl-secrets-status" />
          <div className="dl-secrets-actions">
            <button
              type="button"
              className="dl-secrets-btn dl-secrets-btn-secondary"
              onClick={close}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RevealedField({ field, value }: { field: string; value: string }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context); the show button still works.
    }
  };
  return (
    <div className="dl-secrets-field">
      <div className="dl-secrets-field-head">
        <span className="dl-secrets-label mono">{field}</span>
      </div>
      <div className="dl-secrets-input-wrap">
        <input
          className="dl-secrets-input mono"
          type={show ? "text" : "password"}
          readOnly
          autoComplete="off"
          aria-label={`${field} value`}
          value={value}
        />
        <button
          type="button"
          className="dl-secrets-eye dl-tap-compact dl-vault-copy"
          onClick={() => void copy()}
          aria-label="Copy value"
          title="Copy value"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button
          type="button"
          className="dl-secrets-eye dl-tap-compact"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide value" : "Show value"}
          title={show ? "Hide value" : "Show value"}
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  );
}
