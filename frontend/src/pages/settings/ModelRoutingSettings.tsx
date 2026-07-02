import { useEffect, useRef, useState } from "react";
import { Route, Plus, Trash2 } from "lucide-react";
import { getAgentSettings, updateAgentSettings } from "../../api";
import type { AgentSettings, ModelRoutingConfig } from "shared/types/index.js";
import { validateModelRoutingConfig } from "shared/types/index.js";
import OpenRouterModelSelector from "../../components/OpenRouterModelSelector";

/**
 * Model Routing settings (OpenRouter-only).
 *
 * Lets the user define task CLASSES (the classifier chooses one) and RANKS/tiers
 * (the user picks one per chat), and map each `class × rank` cell to an
 * OpenRouter model. A cheap classifier model reads the first prompt to pick the
 * class. Persisted onto AgentSettings.modelRouting via PUT /api/agent-settings.
 */

const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 20,
  background: "var(--bg)",
  marginBottom: 16,
};
const headerStyle: React.CSSProperties = { marginBottom: 6, display: "flex", alignItems: "center", gap: 8 };
const subtitleStyle: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)", marginBottom: 12 };
const labelStyle: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 4 };
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 13,
  boxSizing: "border-box",
};
const smallBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 12,
  cursor: "pointer",
};
const iconBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 6,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--danger)",
  cursor: "pointer",
};

interface ClassRow {
  id: string;
  label: string;
  description: string;
}
interface RankRow {
  id: string;
  label: string;
}

export default function ModelRoutingSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [orConfigured, setOrConfigured] = useState(true);

  const [enabled, setEnabled] = useState(false);
  const [classifierModel, setClassifierModel] = useState("");
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [ranks, setRanks] = useState<RankRow[]>([]);
  // matrix[classId][rankId] = model slug/alias
  const [matrix, setMatrix] = useState<Record<string, Record<string, string>>>({});
  const [defaultRankId, setDefaultRankId] = useState("");
  const [defaultClassId, setDefaultClassId] = useState("");

  // Monotonic id generators — stable ids keep matrix keys valid across label edits.
  const classSeq = useRef(1);
  const rankSeq = useRef(1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s: AgentSettings = await getAgentSettings();
        if (cancelled) return;
        setOrConfigured(Boolean(s.openRouterApiKey?.trim()));
        const cfg = s.modelRouting;
        if (cfg) {
          setEnabled(cfg.enabled);
          setClassifierModel(cfg.classifierModel ?? "");
          setClasses(cfg.classes.map((c) => ({ id: c.id, label: c.label, description: c.description })));
          const orderedRanks = [...cfg.ranks].sort((a, b) => a.order - b.order);
          setRanks(orderedRanks.map((r) => ({ id: r.id, label: r.label })));
          setMatrix(cfg.matrix ?? {});
          setDefaultRankId(cfg.defaultRankId ?? "");
          setDefaultClassId(cfg.defaultClassId ?? "");
          // Seed the id counters past any numeric suffixes we've seen.
          const maxNum = (ids: string[], prefix: string) =>
            ids.reduce((m, id) => {
              const match = id.match(new RegExp(`^${prefix}(\\d+)$`));
              return match ? Math.max(m, Number(match[1])) : m;
            }, 0);
          classSeq.current = maxNum(cfg.classes.map((c) => c.id), "c") + 1;
          rankSeq.current = maxNum(cfg.ranks.map((r) => r.id), "r") + 1;
        }
      } catch (err: any) {
        setError(err.message || "Failed to load settings");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const addClass = () => setClasses((cs) => [...cs, { id: `c${classSeq.current++}`, label: "", description: "" }]);
  const removeClass = (id: string) => {
    setClasses((cs) => cs.filter((c) => c.id !== id));
    setMatrix((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    if (defaultClassId === id) setDefaultClassId("");
  };
  const updateClass = (id: string, patch: Partial<ClassRow>) => setClasses((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const addRank = () => setRanks((rs) => [...rs, { id: `r${rankSeq.current++}`, label: "" }]);
  const removeRank = (id: string) => {
    setRanks((rs) => rs.filter((r) => r.id !== id));
    setMatrix((m) => {
      const next: Record<string, Record<string, string>> = {};
      for (const [cid, row] of Object.entries(m)) {
        const { [id]: _drop, ...rest } = row;
        next[cid] = rest;
      }
      return next;
    });
    if (defaultRankId === id) setDefaultRankId("");
  };
  const updateRank = (id: string, label: string) => setRanks((rs) => rs.map((r) => (r.id === id ? { ...r, label } : r)));

  const setCell = (classId: string, rankId: string, value: string) =>
    setMatrix((m) => ({ ...m, [classId]: { ...(m[classId] ?? {}), [rankId]: value } }));

  const buildConfig = (): ModelRoutingConfig => {
    const cleanedMatrix: Record<string, Record<string, string>> = {};
    for (const c of classes) {
      const row = matrix[c.id];
      if (!row) continue;
      const cleanedRow: Record<string, string> = {};
      for (const r of ranks) {
        const slug = (row[r.id] ?? "").trim();
        if (slug) cleanedRow[r.id] = slug;
      }
      if (Object.keys(cleanedRow).length > 0) cleanedMatrix[c.id] = cleanedRow;
    }
    return {
      enabled,
      classifierModel: classifierModel.trim(),
      classes: classes.map((c) => ({ id: c.id, label: c.label.trim() || c.id, description: c.description.trim() })),
      ranks: ranks.map((r, i) => ({ id: r.id, label: r.label.trim() || r.id, order: i })),
      matrix: cleanedMatrix,
      ...(defaultRankId && { defaultRankId }),
      ...(defaultClassId && { defaultClassId }),
    };
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    const config = buildConfig();
    const { value, errors } = validateModelRoutingConfig(config);
    if (errors.length > 0) {
      setError(errors.join("; "));
      setSaving(false);
      return;
    }
    try {
      const updated = await updateAgentSettings({ modelRouting: value });
      const cfg = updated.modelRouting;
      if (cfg) {
        setEnabled(cfg.enabled);
        setClassifierModel(cfg.classifierModel ?? "");
        setClasses(cfg.classes.map((c) => ({ id: c.id, label: c.label, description: c.description })));
        const orderedRanks = [...cfg.ranks].sort((a, b) => a.order - b.order);
        setRanks(orderedRanks.map((r) => ({ id: r.id, label: r.label })));
        setMatrix(cfg.matrix ?? {});
        setDefaultRankId(cfg.defaultRankId ?? "");
        setDefaultClassId(cfg.defaultClassId ?? "");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={sectionStyle}>
        <div style={headerStyle}>
          <Route size={16} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--text)" }}>Model Routing</h3>
        </div>
        <div style={subtitleStyle}>
          OpenRouter-only. When enabled, a chat can opt into automatic model selection: a cheap classifier model reads the first prompt to
          choose a <strong>classification</strong>, which combines with the chat&apos;s chosen <strong>tier</strong> to pick the model. The agent
          can also call the <code>reclassify_model</code> tool mid-chat to switch models on the next turn.
        </div>

        {!orConfigured && (
          <div
            style={{
              fontSize: 12,
              color: "var(--warning)",
              background: "var(--warning-bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "8px 10px",
              marginBottom: 12,
            }}
          >
            OpenRouter is not configured. Set an OpenRouter API key in Settings → API before model routing can take effect.
          </div>
        )}

        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 14 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: 16, height: 16 }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Enable model routing</span>
        </label>

        <div style={{ marginBottom: 4 }}>
          <label style={labelStyle}>Classifier model</label>
          <OpenRouterModelSelector value={classifierModel} onChange={setClassifierModel} placeholder="e.g. ~anthropic/claude-haiku-latest" />
          <div style={{ ...subtitleStyle, marginTop: 4, marginBottom: 0 }}>The model that classifies each prompt. Pick something cheap and fast.</div>
        </div>
      </div>

      {/* Classifications */}
      <div style={sectionStyle}>
        <div style={headerStyle}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Classifications</h3>
        </div>
        <div style={subtitleStyle}>Task categories the classifier chooses from. The description guides the classifier — be specific.</div>
        {classes.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>No classifications yet.</div>}
        {classes.map((c) => (
          <div key={c.id} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-start" }}>
            <input
              style={{ ...inputStyle, flex: "0 0 180px" }}
              placeholder="Label (e.g. Coding)"
              value={c.label}
              onChange={(e) => updateClass(c.id, { label: e.target.value })}
            />
            <input
              style={{ ...inputStyle, flex: 1 }}
              placeholder="Description — when should this class be chosen?"
              value={c.description}
              onChange={(e) => updateClass(c.id, { description: e.target.value })}
            />
            <button style={iconBtnStyle} onClick={() => removeClass(c.id)} title="Remove classification" aria-label="Remove classification">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button style={smallBtnStyle} onClick={addClass}>
          <Plus size={14} /> Add classification
        </button>
      </div>

      {/* Ranks / tiers */}
      <div style={sectionStyle}>
        <div style={headerStyle}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Ranks (tiers)</h3>
        </div>
        <div style={subtitleStyle}>Quality/cost tiers, ordered lowest to highest. The user picks one when starting a chat.</div>
        {ranks.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>No ranks yet.</div>}
        {ranks.map((r, i) => (
          <div key={r.id} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)", width: 20, textAlign: "right" }}>{i + 1}</span>
            <input
              style={{ ...inputStyle, flex: "0 0 220px" }}
              placeholder="Label (e.g. Cheap / Balanced / Premium)"
              value={r.label}
              onChange={(e) => updateRank(r.id, e.target.value)}
            />
            <button style={iconBtnStyle} onClick={() => removeRank(r.id)} title="Remove rank" aria-label="Remove rank">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button style={smallBtnStyle} onClick={addRank}>
          <Plus size={14} /> Add rank
        </button>
      </div>

      {/* Matrix */}
      {classes.length > 0 && ranks.length > 0 && (
        <div style={sectionStyle}>
          <div style={headerStyle}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Model matrix</h3>
          </div>
          <div style={subtitleStyle}>Map each classification × tier to an OpenRouter model. Empty cells fall back to a nearby tier, then the chat&apos;s default.</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontSize: 12, color: "var(--text-muted)", position: "sticky", left: 0, background: "var(--bg)" }}>
                    Class \ Tier
                  </th>
                  {ranks.map((r) => (
                    <th key={r.id} style={{ textAlign: "left", padding: "6px 8px", fontSize: 12, color: "var(--text-muted)", minWidth: 220 }}>
                      {r.label.trim() || r.id}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {classes.map((c) => (
                  <tr key={c.id}>
                    <td style={{ padding: "6px 8px", fontSize: 13, color: "var(--text)", fontWeight: 500, position: "sticky", left: 0, background: "var(--bg)", whiteSpace: "nowrap" }}>
                      {c.label.trim() || c.id}
                    </td>
                    {ranks.map((r) => (
                      <td key={r.id} style={{ padding: "6px 8px", minWidth: 220 }}>
                        <OpenRouterModelSelector
                          value={matrix[c.id]?.[r.id] ?? ""}
                          onChange={(v) => setCell(c.id, r.id, v)}
                          placeholder="model…"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Defaults */}
      {(classes.length > 0 || ranks.length > 0) && (
        <div style={sectionStyle}>
          <div style={headerStyle}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Defaults</h3>
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div>
              <label style={labelStyle}>Default tier</label>
              <select value={defaultRankId} onChange={(e) => setDefaultRankId(e.target.value)} style={{ ...inputStyle, width: 220 }}>
                <option value="">(first tier)</option>
                {ranks.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label.trim() || r.id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Fallback class</label>
              <select value={defaultClassId} onChange={(e) => setDefaultClassId(e.target.value)} style={{ ...inputStyle, width: 220 }}>
                <option value="">(first class)</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label.trim() || c.id}
                  </option>
                ))}
              </select>
              <div style={{ ...subtitleStyle, marginTop: 4, marginBottom: 0, width: 220 }}>Used when the classifier is uncertain.</div>
            </div>
          </div>
        </div>
      )}

      {error && <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: "10px 20px",
            borderRadius: 8,
            border: "none",
            background: "var(--accent)",
            color: "var(--text-on-accent)",
            fontSize: 14,
            fontWeight: 600,
            cursor: saving ? "default" : "pointer",
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span style={{ color: "var(--success)", fontSize: 13 }}>Saved</span>}
      </div>
    </div>
  );
}
