import { useEffect, useState } from "react";
import { Route, Plus, Trash2, Save, Check } from "lucide-react";
import { getAgentSettings, updateAgentSettings, getSystemInfo, type AcpProviderInfo } from "../../api";
import { validateModelAliases } from "shared/types/index.js";
import ClaudeModelSelector from "../../components/ClaudeModelSelector";
import CodexModelSelector from "../../components/CodexModelSelector";
import AcpModelSelector from "../../components/AcpModelSelector";
import PiModelSelector from "../../components/PiModelSelector";
import { emptyRow, toRows, toAliases, hasEditableTarget, onlyOpenRouterTarget, type AliasRow } from "./modelAliasRows";

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

const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 20,
  background: "var(--bg)",
  marginBottom: 16,
};
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
  // Configured ACP vendors, for the ACP column's label and its model
  // suggestions. Empty until /system-info answers, and empty is fine — the
  // column still renders as a free-text field, which is all it ever guarantees.
  const [acpProviders, setAcpProviders] = useState<AcpProviderInfo[]>([]);
  // The alias registry keys ACP targets on the KIND, so there is one column
  // whatever the vendor count. It borrows the vendor's name only when that name
  // is unambiguous; with several configured, "ACP" is the honest label because
  // the one target really does apply to all of them.
  const acpLabel = acpProviders.length === 1 ? acpProviders[0].label : "ACP";
  const acpProviderId = acpProviders.length === 1 ? acpProviders[0].id : "";

  const load = async () => {
    setLoading(true);
    try {
      const s = await getAgentSettings();
      setRows(toRows(s.modelAliases));
    } catch (err: any) {
      setError(err.message || "Failed to load settings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    let cancelled = false;
    getSystemInfo()
      .then((info) => {
        if (!cancelled) setAcpProviders(info.acpProviders ?? []);
      })
      .catch(() => {
        // No ACP vendors surfaced — the column stays free text, which is what it
        // degrades to for an unseen vendor anyway.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (i: number, patch: Partial<AliasRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // Live client-side validation mirroring the backend's shared validator, so
  // problems surface before the save round-trips.
  const { errors: validationErrors } = validateModelAliases(toAliases(rows));
  // A named row with no target at all is a likely mistake — flag it even though
  // toAliases() would silently drop it. `openrouter` stays in this test despite
  // having no column: a row carrying only a retained slug still survives the
  // save, so calling it unsaved would be a lie. Such a row gets the per-row
  // legacy note below instead.
  const targetlessNames = rows.filter((r) => r.name.trim() && !hasEditableTarget(r) && !r.openrouter.trim()).map((r) => r.name.trim());

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
    } catch (err: any) {
      setError(err.message || "Failed to save aliases");
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
          <code>gpt-5.5</code> on Codex, <code>opencode/gpt-5.5</code> on an ACP agent. Then set <code>model: &quot;planner&quot;</code> anywhere a model is
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
                  <CodexModelSelector value={row.codex} onChange={(v) => update(i, { codex: v })} placeholder="gpt-5.5" />
                </div>
                {/* One column for the whole ACP family. The registry keys on the
                    kind, not the vendor, so it is labelled with the vendor only
                    while exactly one is configured — with several, the label says
                    ACP because the single target really does apply to all of
                    them. See HarnessProvider's doc-comment for the limitation. */}
                <div style={{ minWidth: 0 }}>
                  <label style={colLabel}>{acpLabel}</label>
                  <AcpModelSelector
                    value={row.acp}
                    onChange={(v) => update(i, { acp: v })}
                    providerId={acpProviderId}
                    placeholder={acpProviderId === "opencode" ? "opencode/gpt-5.5" : "vendor model id"}
                  />
                </div>
                {/* A plain input rather than a selector: Cline's catalog is
                    per-provider and the provider is a global setting, so there
                    is no single list to offer here the way there is for Codex.
                    The Settings → API field, which knows the provider, does
                    offer suggestions. */}
                <div style={{ minWidth: 0 }}>
                  <label style={colLabel}>Cline</label>
                  <input
                    type="text"
                    value={row.cline}
                    onChange={(e) => update(i, { cline: e.target.value })}
                    placeholder="claude-sonnet-4-6"
                    autoComplete="off"
                    spellCheck={false}
                    style={inputStyle}
                  />
                </div>
                {/* A real selector, unlike Cline's: pi's catalog is bundled with
                    the package and answered offline, so it is available here
                    without knowing which provider is configured — and at ~300
                    models it needs the filtering more than any other column. */}
                <div style={{ minWidth: 0 }}>
                  <label style={colLabel}>pi</label>
                  <PiModelSelector value={row.pi} onChange={(v) => update(i, { pi: v })} placeholder="google/gemini-3.6-flash" compact />
                </div>
              </div>

              {/* Only for aliases that predate the OpenRouter harness removal.
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
              {row.openrouter.trim() && (
                <div style={{ ...helpStyle, marginTop: 8, display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                  <span>
                    Retired OpenRouter target (<code>{row.openrouter.trim()}</code>) kept from an earlier version — stored, but no longer used by any harness.
                    {onlyOpenRouterTarget(row) && " Set a target above for the harnesses you run."}
                  </span>
                  <button
                    type="button"
                    onClick={() => update(i, { openrouter: "" })}
                    // Every row's button reads "Clear it", so the accessible
                    // name has to carry the alias to be distinguishable — and
                    // has to open with the visible text, or speech input can't
                    // match it (WCAG 2.5.3, Label in Name).
                    aria-label={`Clear it — the retired OpenRouter target for ${row.name.trim() || "this alias"}`}
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
              )}
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
          color: "#fff",
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
