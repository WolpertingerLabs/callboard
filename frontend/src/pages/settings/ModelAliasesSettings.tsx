import { useEffect, useState } from "react";
import { Route, Plus, Trash2, Save, Check } from "lucide-react";
import { getAgentSettings, updateAgentSettings } from "../../api";
import type { ModelAlias } from "shared/types/index.js";
import { validateModelAliases } from "shared/types/index.js";
import ClaudeModelSelector from "../../components/ClaudeModelSelector";
import OpenRouterModelSelector from "../../components/OpenRouterModelSelector";
import CodexModelSelector from "../../components/CodexModelSelector";

/**
 * Settings → Model Aliases.
 *
 * Edits the cross-harness alias registry (`agentSettings.modelAliases`): one
 * named alias resolves to a different concrete model per harness, so
 * `model: "planner"` works on claude-code, openrouter, and codex alike. This
 * supersedes the OpenRouter-only alias editor that used to live in Settings →
 * API; the backend folds any legacy `openRouterModelAliases` into the
 * `openrouter` column on load, and retires the legacy map on the first save
 * here.
 */

interface AliasRow {
  name: string;
  description: string;
  claudeCode: string;
  openrouter: string;
  codex: string;
}

const emptyRow = (): AliasRow => ({ name: "", description: "", claudeCode: "", openrouter: "", codex: "" });

function toRows(aliases: ModelAlias[] | undefined): AliasRow[] {
  return (aliases ?? []).map((a) => ({
    name: a.name,
    description: a.description ?? "",
    claudeCode: a.targets["claude-code"] ?? "",
    openrouter: a.targets.openrouter ?? "",
    codex: a.targets.codex ?? "",
  }));
}

/** Build the ModelAlias[] a row set represents (blank fields dropped). */
function toAliases(rows: AliasRow[]): ModelAlias[] {
  return rows
    .map((r) => {
      const targets: ModelAlias["targets"] = {};
      if (r.claudeCode.trim()) targets["claude-code"] = r.claudeCode.trim();
      if (r.openrouter.trim()) targets.openrouter = r.openrouter.trim();
      if (r.codex.trim()) targets.codex = r.codex.trim();
      const alias: ModelAlias = { name: r.name.trim(), targets };
      if (r.description.trim()) alias.description = r.description.trim();
      return alias;
    })
    .filter((a) => a.name !== "" && Object.keys(a.targets).length > 0);
}

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
  }, []);

  const update = (i: number, patch: Partial<AliasRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // Live client-side validation mirroring the backend's shared validator, so
  // problems surface before the save round-trips.
  const { errors: validationErrors } = validateModelAliases(toAliases(rows));
  // A named row with no target at all is a likely mistake — flag it even though
  // toAliases() would silently drop it.
  const targetlessNames = rows.filter((r) => r.name.trim() && !r.claudeCode.trim() && !r.openrouter.trim() && !r.codex.trim()).map((r) => r.name.trim());

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
          <code>anthropic/claude-opus-4.8</code> on OpenRouter, <code>gpt-5.5</code> on Codex. Then set <code>model: &quot;planner&quot;</code> anywhere a model is
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

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <label style={colLabel}>Claude Code</label>
                  <ClaudeModelSelector value={row.claudeCode} onChange={(v) => update(i, { claudeCode: v })} placeholder="opus / claude-sonnet-4-6" />
                </div>
                <div style={{ minWidth: 0 }}>
                  <label style={colLabel}>OpenRouter</label>
                  <OpenRouterModelSelector
                    value={row.openrouter}
                    onChange={(v) => update(i, { openrouter: v })}
                    placeholder="anthropic/claude-opus-4.8"
                    priorityPrefix="anthropic/"
                    excludeAliases
                  />
                </div>
                <div style={{ minWidth: 0 }}>
                  <label style={colLabel}>Codex</label>
                  <CodexModelSelector value={row.codex} onChange={(v) => update(i, { codex: v })} placeholder="gpt-5.5" />
                </div>
              </div>
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
