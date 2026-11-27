import { useEffect, useState } from "react";
import { Route, Plus, Trash2, Save, Check } from "lucide-react";
import { getAgentSettings, updateAgentSettings } from "../../api";
import { validateModelAliases } from "shared/types/index.js";
import ClaudeModelSelector from "../../components/ClaudeModelSelector";
import CodexModelSelector from "../../components/CodexModelSelector";
import PiModelSelector from "../../components/PiModelSelector";
import { emptyRow, toRows, toAliases, hasEditableTarget, hasRetiredTarget, onlyRetiredTargets, RETIRED_ALIAS_TARGETS, type AliasRow } from "./modelAliasRows";
import { errorMessage } from "../../utils/errorMessage";
import { sectionStyle } from "./styles";

/**
 * Settings → Model Aliases.
 *
 * Edits the cross-harness alias registry (`agentSettings.modelAliases`): one
 * named alias resolves to a different concrete model per harness, so
 * `model: "planner"` works on claude-code, codex and the rest alike. This
 * supersedes the OpenRouter-only alias editor that used to live in Settings →
 * API; the backend folds any legacy `openRouterModelAliases` into the
 * `openrouter` target on load, and retires the legacy map on the first save
 * here.
 *
 * The row model and its conversions live in `./modelAliasRows` — including the
 * OpenRouter target this page deliberately has no column for. See that file for
 * why it is still carried.
 */

const helpStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 };
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  boxSizing: "border-box",
};
const colLabel: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4, display: "block" };

export default function ModelAliasesSettings() {
  const [rows, setRows] = useState<AliasRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const s = await getAgentSettings();
      setRows(toRows(s.modelAliases));
    } catch (err) {
      setError(errorMessage(err, "Failed to load settings"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const update = (i: number, patch: Partial<AliasRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // Live client-side validation mirroring the backend's shared validator, so
  // problems surface before the save round-trips.
  const { errors: validationErrors } = validateModelAliases(toAliases(rows));
  // A named row with no target at all is a likely mistake — flag it even though
  // toAliases() would silently drop it. The retired targets (`openrouter`,
  // `cline`, `acp`) stay in this test despite having no column: a row carrying only a
  // retained slug still survives the
  // save, so calling it unsaved would be a lie. Such a row gets the per-row
  // legacy note below instead.
  const targetlessNames = rows.filter((r) => r.name.trim() && !hasEditableTarget(r) && !hasRetiredTarget(r)).map((r) => r.name.trim());

  const handleSave = async () => {
    if (validationErrors.length > 0) {
      setError(validationErrors.join("; "));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const updated = await updateAgentSettings({ modelAliases: toAliases(rows) });
      setRows(toRows(updated.modelAliases));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(errorMessage(err, "Failed to save aliases"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <Route size={16} />
          <div style={{ fontSize: 15, fontWeight: 600 }}>Model Aliases</div>
        </div>
        <div style={helpStyle}>
          Name a shortcut once and point it at a different model per harness — e.g. <code>planner</code> → <code>opus</code> on Claude Code,{" "}
          <code>gpt-6.2-sol</code> on Codex, <code>google/gemini-3.6-flash</code> on pi. Then set <code>model: &quot;planner&quot;</code> anywhere a model is
          configured (new chats, per-chat overrides, job steps, cron/trigger actions) and it resolves to the target for whichever harness runs the session.
          Leave a harness blank to fall back to that provider&rsquo;s configured default. Targets must be real model ids, never other alias names.
        </div>

        <div style={{ marginTop: 16 }}>
          {rows.length === 0 && <div style={{ ...helpStyle, marginTop: 0, marginBottom: 12 }}>No aliases yet. Add one below.</div>}

          {rows.map((row, i) => (
            <div
              key={i}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 12,
                marginBottom: 10,
                background: "var(--bg-secondary)",
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 10 }}>
                <div style={{ width: 200, flexShrink: 0 }}>
                  <label style={colLabel}>Alias name</label>
                  <input
                    type="text"
                    value={row.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    placeholder="planner"
                    autoComplete="off"
                    spellCheck={false}
                    style={inputStyle}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <label style={colLabel}>Description (optional)</label>
                  <input
                    type="text"
                    value={row.description}
                    onChange={(e) => update(i, { description: e.target.value })}
                    placeholder="Frontier planner for decomposition & design"
                    autoComplete="off"
                    spellCheck={false}
                    style={inputStyle}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  title="Remove alias"
                  style={{
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    padding: 8,
                    display: "flex",
                    alignItems: "center",
                    flexShrink: 0,
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <label style={colLabel}>Claude Code</label>
                  <ClaudeModelSelector value={row.claudeCode} onChange={(v) => update(i, { claudeCode: v })} placeholder="opus / claude-sonnet-4-6" />
                </div>
                <div style={{ minWidth: 0 }}>
                  <label style={colLabel}>Codex</label>
                  <CodexModelSelector value={row.codex} onChange={(v) => update(i, { codex: v })} placeholder="gpt-6.2-sol" />
                </div>
                {/* A real selector: pi's catalog is bundled with
                    the package and answered offline, so it is available here
                    without knowing which provider is configured — and at ~300
                    models it needs the filtering more than any other column. */}
                <div style={{ minWidth: 0 }}>
                  <label style={colLabel}>pi</label>
                  <PiModelSelector value={row.pi} onChange={(v) => update(i, { pi: v })} placeholder="google/gemini-3.6-flash" compact />
                </div>
              </div>

              {/* Only for aliases that predate a harness removal (OpenRouter, Cline, OpenCode).
                  The retained target has no column, so without this the value is
                  invisible — and a row whose *sole* target is that slug reads as
                  blank-but-somehow-saved with nowhere to learn why. The advice to
                  fill in a harness is gated on that sole-target case: the
                  migration gave an OpenRouter target to every legacy alias, so
                  most rows carrying one are already configured elsewhere and
                  telling those to go set a target is telling them to redo work
                  they have done. Clearing is offered because otherwise the note
                  is a permanent nag whose only escape is deleting the alias
                  outright — an explicit click is not the silent drop that
                  keeping the value in AliasRow exists to prevent. */}
              {RETIRED_ALIAS_TARGETS.filter(({ key }) => row[key].trim()).map(({ key, label }) => (
                <div key={key} style={{ ...helpStyle, marginTop: 8, display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                  <span>
                    Retired {label} target (<code>{row[key].trim()}</code>) kept from an earlier version — stored, but no longer used by any harness.
                    {onlyRetiredTargets(row) && " Set a target above for the harnesses you run."}
                  </span>
                  <button
                    type="button"
                    onClick={() => update(i, { [key]: "" })}
                    // Every row's button reads "Clear it", so the accessible
                    // name has to carry the alias to be distinguishable — and
                    // has to open with the visible text, or speech input can't
                    // match it (WCAG 2.5.3, Label in Name).
                    aria-label={`Clear it — the retired ${label} target for ${row.name.trim() || "this alias"}`}
                    style={{
                      background: "transparent",
                      border: "none",
                      borderBottom: "1px solid var(--border)",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      padding: 0,
                      fontSize: 11,
                      lineHeight: 1.5,
                    }}
                  >
                    Clear it
                  </button>
                </div>
              ))}
            </div>
          ))}

          {targetlessNames.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--warning, var(--text-muted))", marginBottom: 8 }}>
              {targetlessNames.length === 1 ? "Alias" : "Aliases"} with no target set (won&rsquo;t be saved): {targetlessNames.join(", ")}
            </div>
          )}
          {validationErrors.length > 0 && <div style={{ fontSize: 11, color: "var(--error)", marginBottom: 8 }}>{validationErrors.join("; ")}</div>}

          <button
            type="button"
            onClick={() => setRows((rs) => [...rs, emptyRow()])}
            style={{
              background: "transparent",
              border: "1px dashed var(--border)",
              borderRadius: 8,
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: "8px 12px",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Plus size={14} /> Add alias
          </button>
        </div>
      </div>

      {error && <div style={{ color: "var(--error)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <button
        onClick={handleSave}
        disabled={saving || validationErrors.length > 0}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 18px",
          borderRadius: 8,
          border: "none",
          background: "var(--accent)",
          color: "var(--text-on-accent)",
          fontSize: 14,
          fontWeight: 600,
          cursor: saving || validationErrors.length > 0 ? "not-allowed" : "pointer",
          opacity: saving || validationErrors.length > 0 ? 0.6 : 1,
        }}
      >
        {saved ? <Check size={16} /> : <Save size={16} />}
        {saved ? "Saved" : saving ? "Saving…" : "Save aliases"}
      </button>
    </div>
  );
}
