import { useState, useEffect, type CSSProperties } from "react";
import { RefreshCw, X } from "lucide-react";
import { useStaleBuildId } from "../contexts/SessionContext";
import { shouldPromptReload } from "../utils/buildIdentity";
import { getDismissedStaleBuildId, saveDismissedStaleBuildId } from "../utils/localStorage";

/**
 * "Callboard changed on the server. Reload when you're ready."
 *
 * The signal this draws already existed in the product, twice, and both times
 * only *after* something broke. #364 shipped a REST shape change that an old
 * tab read straight into a `TypeError`; #367 gave that crash a fallback whose
 * copy says reloading usually fixes it. This is the same sentence, said before
 * the crash instead of after it — which is the only version of it the user can
 * act on cheaply.
 *
 * Three properties, and they are the design rather than decoration:
 *
 * **It never reloads on its own.** Not on a timer, not after N polls, not
 * "when idle". The composer may be holding a half-written message — #367's
 * tests pin that a draft survives a sidebar crash, and it would be a poor
 * trade to lose it to the thing that was supposed to prevent the crash. The
 * button is the only path to `location.reload()`, and a user who ignores this
 * forever is a user whose tab keeps working exactly as well as it did a minute
 * ago.
 *
 * **It does not block.** Fixed to the top-right, clear of the composer at the
 * bottom of every layout including mobile; below the modal layer, so a dialog
 * covers it rather than the reverse; no focus trap, no autofocus, nothing that
 * moves the caret out of a textarea mid-sentence.
 *
 * **It does not nag.** Dismissal is keyed by build id
 * (`utils/buildIdentity.ts`), so "not now" holds for the upgrade it was
 * clicked for and lifts the moment the daemon moves again — which is the one
 * moment the news is new. It is also stored rather than held in state, and the
 * `storage` listener below is what makes that reach the tabs it needs to: an
 * upgrade puts this banner up in *every* open tab at once, and those are
 * exactly the tabs that have already mounted and will never re-read the store
 * on their own. Without the listener, "one click per tab" — which is the shape
 * of nagging this is meant to avoid.
 */
export default function StaleBundleBanner() {
  const staleBuildId = useStaleBuildId();
  const [dismissed, setDismissed] = useState<string | null>(() => getDismissedStaleBuildId());

  // `storage` fires in the *other* tabs on this origin, never the one that
  // wrote — so this is only ever catching someone else's dismissal, and cannot
  // loop with the write below.
  useEffect(() => {
    const onStorage = () => setDismissed(getDismissedStaleBuildId());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  if (!shouldPromptReload({ staleBuildId: staleBuildId ?? undefined }, dismissed)) return null;

  const dismiss = () => {
    // Persist before the state write: the state is what hides it now, the
    // store is what keeps it hidden across a route change or a second tab.
    saveDismissedStaleBuildId(staleBuildId!);
    setDismissed(staleBuildId);
  };

  return (
    // `status`/`polite`, not `alert`/`assertive`. A screen reader should finish
    // the sentence it is on; nothing here is urgent enough to interrupt.
    <div role="status" aria-live="polite" data-testid="stale-bundle-banner" style={wrapStyle}>
      <RefreshCw size={16} style={{ color: "var(--warning)", flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        {/* Worded without a direction. The daemon usually moves forward, but it
            can be rolled back, and "Callboard was updated" over a downgrade is
            simply false — while the advice underneath it stays true either way,
            because what makes the tab wrong is the mismatch, not which side of
            it is newer. */}
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Callboard changed on the server</span>
        <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45 }}>
          This tab is running a different version. Reload when you&rsquo;re ready — anything you&rsquo;ve typed stays put until you do.
        </span>
        <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
          <button type="button" onClick={() => window.location.reload()} style={reloadButtonStyle}>
            Reload
          </button>
          <button type="button" onClick={dismiss} style={laterButtonStyle}>
            Not now
          </button>
        </div>
      </div>
      <button type="button" onClick={dismiss} aria-label="Dismiss update notice" title="Dismiss" style={closeButtonStyle}>
        <X size={14} />
      </button>
    </div>
  );
}

const wrapStyle: CSSProperties = {
  position: "fixed",
  top: 12,
  right: 12,
  // Under `ModalOverlay` and the error-boundary backdrop, both at 1000. A
  // dialog that has the user's attention should keep it.
  zIndex: 900,
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
  width: "min(340px, calc(100vw - 24px))",
  padding: "12px 12px 12px 14px",
  borderRadius: "var(--radius)",
  background: "var(--surface)",
  border: "1px solid var(--warning)",
  boxShadow: "var(--shadow-md)",
};

const buttonBase: CSSProperties = {
  padding: "5px 12px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

const reloadButtonStyle: CSSProperties = {
  ...buttonBase,
  background: "var(--accent)",
  color: "var(--text-on-accent)",
  border: "none",
};

const laterButtonStyle: CSSProperties = {
  ...buttonBase,
  background: "transparent",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
};

const closeButtonStyle: CSSProperties = {
  marginLeft: "auto",
  padding: 2,
  background: "transparent",
  border: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  flexShrink: 0,
};
