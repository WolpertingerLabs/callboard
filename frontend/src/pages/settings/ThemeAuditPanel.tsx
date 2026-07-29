/**
 * The audit of a stored theme, as the settings row shows it.
 *
 * Two things were wrong with rendering this as one flat list, and the second is
 * the more serious:
 *
 * - **It was a wall.** 26 undifferentiated 11px rows with `dark` and `light`
 *   interleaved, six `where` strings appearing twice with only a mode column to
 *   tell them apart, pushing the rest of the settings panel off-screen. A report
 *   nobody reads to the end reports nothing. So: a summary line first, grouped
 *   by mode, and the detail in a box that scrolls instead of growing.
 *
 * - **It omitted the half a user is more likely to be looking at.** The
 *   variables a theme never defines produce *zero* contrast failures — each
 *   inherited colour is perfectly legible on its own — so a panel that showed
 *   only ratios said nothing at all about the sidebar being the wrong colour.
 *   That is a different bug with a different fix, and it belongs here beside the
 *   ratios rather than nowhere.
 *
 * Reported, never repaired. A stored theme is the user's file; this says what is
 * wrong with it and leaves the choice — regenerate, edit, ignore — to them.
 */
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { ThemeContrastReport, ThemeContrastFailure } from "../../api";

/** "2.62:1 / 4.5", or the fact that the value could not be read at all. */
function ratioLabel(f: ThemeContrastFailure): string {
  return f.ratio === null ? "unreadable" : `${f.ratio}:1 / ${f.required}`;
}

/** The one line that has to survive not expanding the detail. */
function worstLine(failures: ThemeContrastFailure[]): string {
  const dark = failures.filter((f) => f.mode === "dark").length;
  const light = failures.length - dark;
  const worst = failures[0]; // the report is sorted worst-first
  // Long enough for every `where` the pairing table actually holds; the cap is
  // there so a future one cannot push this line onto two.
  const where = worst.where.length > 60 ? `${worst.where.slice(0, 59)}…` : worst.where;
  return `${dark} dark / ${light} light — worst: ${where} ${ratioLabel(worst)}`;
}

const rowStyle = { fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 8 } as const;

export default function ThemeAuditPanel({ report }: { report: ThemeContrastReport }) {
  const [open, setOpen] = useState(false);

  const failures = report.failures;
  // Both modes normally miss the same names; show one list when they agree and
  // say so per mode when they do not, rather than always printing two.
  const undefinedDark = report.undefinedVariables?.dark ?? [];
  const undefinedLight = report.undefinedVariables?.light ?? [];
  const sameBothModes = undefinedDark.length === undefinedLight.length && undefinedDark.every((n) => undefinedLight.includes(n));
  const undefinedCount = new Set([...undefinedDark, ...undefinedLight]).size;

  if (failures.length === 0 && undefinedCount === 0) return null;

  const summary = [
    failures.length > 0 ? `${failures.length} of ${report.checked} colour pairings fall below WCAG AA` : null,
    undefinedCount > 0 ? `${undefinedCount} variable${undefinedCount === 1 ? "" : "s"} not defined` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div style={{ paddingLeft: 4 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "var(--warning-bg)",
          // --text, not --warning: this row exists to report that a theme's
          // colours are unreadable, and --warning on --warning-bg is one of the
          // pairings it reports on. The notice about low contrast must not be
          // the low contrast.
          color: "var(--text)",
          border: "none",
          borderRadius: 6,
          padding: "5px 8px",
          fontSize: 11,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <AlertTriangle size={12} style={{ color: "var(--warning)", flexShrink: 0 }} />
        {summary}
      </button>

      {open && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
          {failures.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 11, color: "var(--text)", fontWeight: 500 }}>{worstLine(failures)}</div>
              {/* Scrolls rather than growing: 26 rows used to push everything
                  below this row off the page. */}
              <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {(["dark", "light"] as const).map((mode) => {
                  const inMode = failures.filter((f) => f.mode === mode);
                  if (inMode.length === 0) return null;
                  return (
                    <div key={mode} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                        {mode} mode · {inMode.length}
                      </div>
                      {inMode.map((f) => (
                        <div key={f.id} style={rowStyle}>
                          <span style={{ width: 74, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{ratioLabel(f)}</span>
                          <span>{f.where}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {undefinedCount > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>not defined by this theme</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {sameBothModes ? (
                  <span>{undefinedDark.map((n) => `--${n}`).join(", ")}</span>
                ) : (
                  <>
                    {undefinedDark.length > 0 && <div>dark: {undefinedDark.map((n) => `--${n}`).join(", ")}</div>}
                    {undefinedLight.length > 0 && <div>light: {undefinedLight.map((n) => `--${n}`).join(", ")}</div>}
                  </>
                )}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                These fall back to the built-in palette, so the features that use them are painted in a different theme than the rest of the app. No
                contrast check catches this — each colour is legible on its own.
              </div>
            </div>
          )}

          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Regenerating this theme produces one that is checked and corrected before it is saved. Nothing here is changed for you.
          </div>
        </div>
      )}
    </div>
  );
}
