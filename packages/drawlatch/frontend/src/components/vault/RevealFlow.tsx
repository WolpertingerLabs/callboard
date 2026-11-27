/**
 * Reveal a vault item: a (neutral) confirmation, then the values in masked
 * fields with show and copy buttons.
 *
 * The revealed values are held ONLY in this component's state: never in a
 * shared cache, context, URL, or storage. They are cleared when the panel is
 * closed, after REVEAL_TTL_MS, and on any route change (including a change
 * of `?caller=`). Unmounting drops them too.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import type { AdminVaultItem } from "drawlatch-admin-types";
import { api } from "../../api";
import { useDaemon } from "../../contexts/DaemonContext";
import ConfirmDialog from "../ConfirmDialog";
import Modal from "../Modal";
import { copyText } from "../../utils/clipboard";
import { CallerPill } from "./VaultModals";
import "./VaultForms.css";

export const REVEAL_TTL_MS = 60_000;
const REVEAL_TTL_S = REVEAL_TTL_MS / 1000;

interface Props {
  caller: string;
  item: AdminVaultItem;
  onClose: () => void;
}

export default function RevealFlow({ caller, item, onClose }: Props) {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_TTL_S);
  const location = useLocation();
  const openedAt = useRef(location.key);

  const close = () => {
    setValues(null);
    onClose();
  };

  // The daemon going away → clear and close (the vault page stays mounted
  // through an offline blip, so this doesn't happen by itself).
  const { daemon } = useDaemon();
  useEffect(() => {
    if (daemon === "down") {
      setValues(null);
      onClose();
    }
  }, [daemon, onClose]);

  // Route change (including ?caller=) → clear and close.
  useEffect(() => {
    if (location.key !== openedAt.current) {
      setValues(null);
      onClose();
    }
  }, [location.key, onClose]);

  // REVEAL_TTL_MS after the values arrive → clear and close.
  const revealed = values !== null;
  useEffect(() => {
    if (!revealed) return;
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
  }, [revealed]);

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
        variant="neutral"
        title={`Reveal "${item.name}"?`}
        confirmLabel="Reveal"
        description={
          <>
            This shows the value on screen and is recorded in <code>{caller}</code>&apos;s audit
            log. It is cleared after {REVEAL_TTL_S} seconds, or as soon as you close it.
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
    <Modal
      open
      title={item.name}
      subtitle={
        <>
          <CallerPill alias={caller} /> · clears in{" "}
          <span className="dl-vf-countdown" aria-live="off">
            {secondsLeft}s
          </span>
        </>
      }
      onClose={close}
      size="sm"
      footer={
        <button type="button" className="btn btn-secondary" onClick={close}>
          Close
        </button>
      }
    >
      <div className="dl-vf-fields">
        {Object.entries(values)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([field, value]) => (
            <RevealedField key={field} field={field} value={value} />
          ))}
      </div>
    </Modal>
  );
}

function RevealedField({ field, value }: { field: string; value: string }) {
  const [show, setShow] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const lines = value.split("\n").length;
  const multiline = lines > 1;
  const id = `dl-vault-revealed-${field}`;

  const doCopy = async () => {
    const ok = await copyText(value);
    setCopy(ok ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopy("idle"), 1500);
  };

  const copyLabel = copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy value";
  return (
    <div className="dl-vf-field">
      <label className="field-label mono" htmlFor={id}>
        {field}
      </label>
      <div className="dl-vf-masked">
        {multiline && !show ? (
          // Hidden: the value isn't in the page at all (a masked textarea
          // would still hand it to screen readers). Only Show mounts it.
          <div
            id={id}
            className="input dl-vf-textarea dl-vf-hidden-note"
            role="textbox"
            aria-readonly="true"
            aria-multiline="true"
            aria-label={`${field}, hidden, ${lines} lines`}
            tabIndex={0}
          >
            <span aria-hidden="true">
              {Array.from({ length: Math.min(lines, 8) }, (_, i) => (
                <span key={i} className="dl-vf-dots">
                  ••••••••••••
                </span>
              ))}
            </span>
          </div>
        ) : multiline ? (
          <textarea
            id={id}
            className="input dl-vf-textarea"
            readOnly
            rows={Math.min(8, lines)}
            value={value}
          />
        ) : (
          <input
            id={id}
            className="input"
            type={show ? "text" : "password"}
            readOnly
            autoComplete="off"
            value={value}
          />
        )}
        <button
          type="button"
          className={`btn btn-secondary btn-icon${copy === "failed" ? " dl-vf-copy-failed" : ""}`}
          onClick={() => void doCopy()}
          aria-label={copyLabel}
          title={copyLabel}
        >
          {copy === "copied" ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <Copy size={14} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-icon"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide value" : "Show value"}
          aria-pressed={show}
          title={show ? "Hide value" : "Show value"}
        >
          {show ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
