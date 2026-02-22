import { useState, useEffect, useRef } from "react";
import { useOutletContext } from "react-router-dom";
import { Plus, Zap, Play, Pause, Trash2, X, Search, ChevronDown, ChevronRight, Info, Pencil } from "lucide-react";
import ModalOverlay from "../../../components/ModalOverlay";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { getAgentTriggers, createAgentTrigger, updateAgentTrigger, deleteAgentTrigger, backtestTriggerFilter, getProxyEvents } from "../../../api";
import type { Trigger, FilterCondition, TriggerFilter, AgentConfig, BacktestResult, StoredEvent } from "../../../api";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const statusConfig: Record<string, { color: string; icon: typeof Play; label: string }> = {
  active: { color: "var(--success)", icon: Play, label: "Active" },
  paused: { color: "var(--warning)", icon: Pause, label: "Paused" },
};

export default function Triggers() {
  const { agent } = useOutletContext<{ agent: AgentConfig }>();
  const isMobile = useIsMobile();
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formSource, setFormSource] = useState("");
  const [formEventType, setFormEventType] = useState("");
  const [formConditions, setFormConditions] = useState<FilterCondition[]>([]);
  const [formPrompt, setFormPrompt] = useState("");
  const [formSaving, setFormSaving] = useState(false);

  // Backtest state
  const [backtestResults, setBacktestResults] = useState<BacktestResult | null>(null);
  const [backtesting, setBacktesting] = useState(false);
  const [expandedBacktestEvent, setExpandedBacktestEvent] = useState<number | null>(null);

  // Template info modal
  const [showTemplateInfo, setShowTemplateInfo] = useState(false);

  // Editing state
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Available sources for dropdown
  const [availableSources, setAvailableSources] = useState<string[]>([]);

  const loadTriggers = () => {
    setLoading(true);
    getAgentTriggers(agent.alias)
      .then(setTriggers)
      .catch(() => setTriggers([]))
      .finally(() => setLoading(false));
  };

  useEffect(loadTriggers, [agent.alias]);

  // Fetch available event sources on mount
  useEffect(() => {
    getProxyEvents(1)
      .then((data) => setAvailableSources(data.sources))
      .catch(() => setAvailableSources([]));
  }, []);

  const buildFilter = (): TriggerFilter => ({
    ...(formSource && { source: formSource }),
    ...(formEventType.trim() && { eventType: formEventType.trim() }),
    ...(formConditions.length > 0 && { conditions: formConditions }),
  });

  const toggleTrigger = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "paused" : "active";
    try {
      const updated = await updateAgentTrigger(agent.alias, id, { status: newStatus });
      setTriggers((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch {
      // ignore
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteAgentTrigger(agent.alias, id);
      setTriggers((prev) => prev.filter((t) => t.id !== id));
    } catch {
      // ignore
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) return;

    setFormSaving(true);
    try {
      const trigger = await createAgentTrigger(agent.alias, {
        name: formName.trim(),
        description: formDescription.trim(),
        status: "active",
        filter: buildFilter(),
        action: { type: "start_session", prompt: formPrompt.trim() || undefined },
        triggerCount: 0,
      });
      setTriggers((prev) => [...prev, trigger]);
      setShowForm(false);
      resetForm();
    } catch {
      // ignore
    } finally {
      setFormSaving(false);
    }
  };

  const resetForm = () => {
    setFormName("");
    setFormDescription("");
    setFormSource("");
    setFormEventType("");
    setFormConditions([]);
    setFormPrompt("");
    setBacktestResults(null);
    setEditingTriggerId(null);
  };

  const handleBacktest = async () => {
    setBacktesting(true);
    setExpandedBacktestEvent(null);
    try {
      const results = await backtestTriggerFilter(agent.alias, buildFilter(), 500);
      setBacktestResults(results);
    } catch {
      setBacktestResults(null);
    } finally {
      setBacktesting(false);
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim() || !editingTriggerId) return;

    setFormSaving(true);
    try {
      const updated = await updateAgentTrigger(agent.alias, editingTriggerId, {
        name: formName.trim(),
        description: formDescription.trim(),
        filter: buildFilter(),
        action: { type: "start_session", prompt: formPrompt.trim() || undefined },
      });
      setTriggers((prev) => prev.map((t) => (t.id === editingTriggerId ? updated : t)));
      setShowForm(false);
      resetForm();
    } catch {
      // ignore
    } finally {
      setFormSaving(false);
    }
  };

  const startEditing = (trigger: Trigger) => {
    setEditingTriggerId(trigger.id);
    setFormName(trigger.name);
    setFormDescription(trigger.description);
    setFormSource(trigger.filter.source || "");
    setFormEventType(trigger.filter.eventType || "");
    setFormConditions(trigger.filter.conditions ? trigger.filter.conditions.map((c) => ({ ...c })) : []);
    setFormPrompt(trigger.action.prompt || "");
    setBacktestResults(null);
    setShowForm(true);

    setTimeout(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  // Condition builder helpers
  const addCondition = () => {
    setFormConditions((prev) => [...prev, { field: "", operator: "equals", value: "" }]);
  };

  const removeCondition = (index: number) => {
    setFormConditions((prev) => prev.filter((_, i) => i !== index));
  };

  const updateCondition = (index: number, updates: Partial<FilterCondition>) => {
    setFormConditions((prev) => prev.map((c, i) => (i === index ? { ...c, ...updates } : c)));
  };

  const filterSummary = (filter: TriggerFilter): string => {
    const parts: string[] = [];
    if (filter.source) parts.push(`source=${filter.source}`);
    if (filter.eventType) parts.push(`type=${filter.eventType}`);
    if (filter.conditions?.length) parts.push(`${filter.conditions.length} condition${filter.conditions.length > 1 ? "s" : ""}`);
    return parts.length > 0 ? parts.join(", ") : "Match all events";
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "var(--bg)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
  };

  return (
    <div style={{ padding: isMobile ? "16px" : "24px 32px", maxWidth: 800, margin: "0 auto" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Triggers</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>Event-driven automations that fire when matching events arrive</p>
        </div>
        <button
          onClick={() => {
            setShowForm(!showForm);
            if (showForm) {
              resetForm();
            }
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: showForm ? "transparent" : "var(--accent)",
            color: showForm ? "var(--text-muted)" : "#fff",
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 500,
            border: showForm ? "1px solid var(--border)" : "none",
            transition: "background 0.15s",
          }}
        >
          {showForm ? <X size={16} /> : <Plus size={16} />}
          {!isMobile && (showForm ? "Cancel" : "New Trigger")}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <form
          ref={formRef}
          onSubmit={editingTriggerId ? handleUpdate : handleCreate}
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 20,
            marginBottom: 20,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {editingTriggerId && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 12px",
                background: "color-mix(in srgb, var(--accent) 8%, transparent)",
                border: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
                borderRadius: 8,
                fontSize: 13,
                color: "var(--accent)",
                fontWeight: 500,
              }}
            >
              <Pencil size={14} />
              Editing trigger
            </div>
          )}
          <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Trigger name" style={inputStyle} />
          <input
            type="text"
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
            placeholder="Description (optional)"
            style={inputStyle}
          />

          {/* Filter section */}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: 10,
                display: "block",
              }}
            >
              Event Filter
            </label>

            <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
              {/* Source dropdown */}
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>Source</label>
                <select value={formSource} onChange={(e) => setFormSource(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
                  <option value="">Any source</option>
                  {availableSources.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              {/* Event type */}
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>Event Type</label>
                <input
                  type="text"
                  value={formEventType}
                  onChange={(e) => setFormEventType(e.target.value)}
                  placeholder="e.g. MESSAGE_CREATE"
                  style={inputStyle}
                />
              </div>
            </div>

            {/* Conditions */}
            {formConditions.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>Conditions</label>
                {formConditions.map((cond, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      type="text"
                      value={cond.field}
                      placeholder="data.field.path"
                      onChange={(e) => updateCondition(i, { field: e.target.value })}
                      style={{ ...inputStyle, flex: 2, minWidth: 120 }}
                    />
                    <select
                      value={cond.operator}
                      onChange={(e) => updateCondition(i, { operator: e.target.value as FilterCondition["operator"] })}
                      style={{ ...inputStyle, flex: 1, minWidth: 120, cursor: "pointer" }}
                    >
                      <option value="equals">equals</option>
                      <option value="contains">contains</option>
                      <option value="matches">matches (regex)</option>
                      <option value="exists">exists</option>
                      <option value="not_exists">not exists</option>
                    </select>
                    {cond.operator !== "exists" && cond.operator !== "not_exists" && (
                      <input
                        type="text"
                        value={cond.value || ""}
                        placeholder="Value"
                        onChange={(e) => updateCondition(i, { value: e.target.value })}
                        style={{ ...inputStyle, flex: 2, minWidth: 120 }}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => removeCondition(i)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 8,
                        borderRadius: 6,
                        background: "transparent",
                        color: "var(--danger, #f85149)",
                        border: "1px solid color-mix(in srgb, var(--danger, #f85149) 30%, transparent)",
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={addCondition}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                background: "transparent",
                color: "var(--text-muted)",
                border: "1px solid var(--border)",
                cursor: "pointer",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <Plus size={12} />
              Add condition
            </button>
          </div>

          {/* Prompt template */}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Prompt Template
              </label>
              <button
                type="button"
                onClick={() => setShowTemplateInfo(true)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 2,
                  background: "transparent",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  borderRadius: 4,
                }}
                title="Template variable reference"
              >
                <Info size={14} />
              </button>
            </div>
            <textarea
              value={formPrompt}
              onChange={(e) => setFormPrompt(e.target.value)}
              placeholder={
                "Use {{event.source}}, {{event.eventType}}, {{event.data}}, {{event.data.field.path}} to inject event data.\n\nLeave empty for a default prompt with the full event payload."
              }
              rows={4}
              style={{ ...inputStyle, resize: "vertical", minHeight: 80, fontFamily: "var(--font-mono)", fontSize: 13 }}
            />
          </div>

          {/* Actions row */}
          <div style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
            {/* Backtest button */}
            <button
              type="button"
              onClick={handleBacktest}
              disabled={backtesting}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 14px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 500,
                background: "transparent",
                color: "var(--accent)",
                border: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
                cursor: backtesting ? "not-allowed" : "pointer",
                opacity: backtesting ? 0.6 : 1,
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => !backtesting && (e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 8%, transparent)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <Search size={14} />
              {backtesting ? "Testing..." : "Backtest Filter"}
            </button>

            {/* Create button */}
            <button
              type="submit"
              disabled={!formName.trim() || formSaving}
              style={{
                background: "var(--accent)",
                color: "#fff",
                padding: "10px 18px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 500,
                opacity: !formName.trim() || formSaving ? 0.5 : 1,
                cursor: !formName.trim() || formSaving ? "not-allowed" : "pointer",
              }}
            >
              {formSaving ? (editingTriggerId ? "Saving..." : "Creating...") : editingTriggerId ? "Save Changes" : "Create Trigger"}
            </button>
          </div>

          {/* Backtest results */}
          {backtestResults && (
            <div
              style={{
                background: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: 14,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <Zap size={14} style={{ color: backtestResults.matchCount > 0 ? "var(--success)" : "var(--text-muted)" }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {backtestResults.matchCount} match{backtestResults.matchCount !== 1 ? "es" : ""}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>out of {backtestResults.totalScanned} events scanned</span>
              </div>

              {backtestResults.matches.length > 0 && (
                <div
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    overflow: "hidden",
                    maxHeight: 300,
                    overflowY: "auto",
                  }}
                >
                  {backtestResults.matches.slice(0, 20).map((event: StoredEvent, i: number) => (
                    <div
                      key={`${event.source}-${event.id}`}
                      style={{
                        borderBottom: i < Math.min(backtestResults.matches.length, 20) - 1 ? "1px solid var(--border)" : "none",
                      }}
                    >
                      <div
                        onClick={() => setExpandedBacktestEvent(expandedBacktestEvent === event.id ? null : event.id)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "8px 12px",
                          cursor: "pointer",
                          fontSize: 12,
                          transition: "background 0.1s",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        {expandedBacktestEvent === event.id ? (
                          <ChevronDown size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                        ) : (
                          <ChevronRight size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                        )}
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            fontFamily: "monospace",
                            padding: "1px 5px",
                            borderRadius: 3,
                            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                            color: "var(--accent)",
                            flexShrink: 0,
                          }}
                        >
                          {event.source}
                        </span>
                        <span style={{ fontWeight: 500, fontFamily: "monospace", flexShrink: 0 }}>{event.eventType}</span>
                        <span
                          style={{
                            color: "var(--text-muted)",
                            flex: 1,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {JSON.stringify(event.data).slice(0, 80)}
                        </span>
                        <span style={{ color: "var(--text-muted)", flexShrink: 0, fontSize: 11 }}>{timeAgo(event.storedAt)}</span>
                      </div>

                      {expandedBacktestEvent === event.id && (
                        <div style={{ padding: "0 12px 10px 32px" }}>
                          <pre
                            style={{
                              background: "var(--bg)",
                              border: "1px solid var(--border)",
                              borderRadius: 6,
                              padding: 10,
                              fontSize: 11,
                              fontFamily: "monospace",
                              overflow: "auto",
                              maxHeight: 200,
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-all",
                            }}
                          >
                            {typeof event.data === "string" ? event.data : JSON.stringify(event.data, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </form>
      )}

      {/* Trigger list */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--text-muted)", fontSize: 14 }}>Loading triggers...</div>
      ) : triggers.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--text-muted)", fontSize: 14 }}>
          <Zap size={24} style={{ marginBottom: 8, opacity: 0.4 }} />
          <p>No triggers yet</p>
          <p style={{ fontSize: 12, marginTop: 4 }}>Create a trigger to automatically run agent sessions when events match your filters.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {triggers.map((trigger) => {
            const sConf = statusConfig[trigger.status] || statusConfig.active;
            const StatusIcon = sConf.icon;

            return (
              <div
                key={trigger.id}
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: isMobile ? "14px 16px" : "16px 20px",
                }}
              >
                {/* Top row: name + status */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    marginBottom: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <h3 style={{ fontSize: 15, fontWeight: 600 }}>{trigger.name}</h3>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 11,
                      fontWeight: 500,
                      color: sConf.color,
                      background: `color-mix(in srgb, ${sConf.color} 12%, transparent)`,
                      padding: "3px 8px",
                      borderRadius: 6,
                    }}
                  >
                    <StatusIcon size={12} />
                    {sConf.label}
                  </span>
                </div>

                {/* Filter summary */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 13,
                    color: "var(--text-muted)",
                    marginBottom: 6,
                  }}
                >
                  <Zap size={13} />
                  <span style={{ fontFamily: "monospace", fontSize: 12 }}>{filterSummary(trigger.filter)}</span>
                </div>

                {/* Description */}
                {trigger.description && <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 10 }}>{trigger.description}</p>}

                {/* Footer */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingTop: 10,
                    borderTop: "1px solid var(--border)",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-muted)" }}>
                    <span>
                      Fired: {trigger.triggerCount} time{trigger.triggerCount !== 1 ? "s" : ""}
                    </span>
                    {trigger.lastTriggered && <span>Last: {timeAgo(trigger.lastTriggered)}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => startEditing(trigger)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 12px",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 500,
                        background: "transparent",
                        color: "var(--accent)",
                        border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                        transition: "background 0.15s",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 10%, transparent)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <Pencil size={12} />
                      Edit
                    </button>
                    <button
                      onClick={() => toggleTrigger(trigger.id, trigger.status)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 12px",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 500,
                        background: "transparent",
                        color: trigger.status === "active" ? "var(--warning)" : "var(--success)",
                        border: `1px solid color-mix(in srgb, ${trigger.status === "active" ? "var(--warning)" : "var(--success)"} 30%, transparent)`,
                        transition: "background 0.15s",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background = `color-mix(in srgb, ${trigger.status === "active" ? "var(--warning)" : "var(--success)"} 10%, transparent)`)
                      }
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      {trigger.status === "active" ? <Pause size={12} /> : <Play size={12} />}
                      {trigger.status === "active" ? "Pause" : "Resume"}
                    </button>
                    <button
                      onClick={() => handleDelete(trigger.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "6px 10px",
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 500,
                        background: "transparent",
                        color: "var(--danger, #f85149)",
                        border: "1px solid color-mix(in srgb, var(--danger, #f85149) 30%, transparent)",
                        cursor: "pointer",
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Template variable info modal */}
      {showTemplateInfo && (
        <ModalOverlay style={{ padding: "20px" }}>
          <div
            style={{
              backgroundColor: "var(--bg)",
              borderRadius: 12,
              width: "100%",
              maxWidth: 520,
              maxHeight: "80vh",
              overflow: "hidden",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
              border: "1px solid var(--border)",
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: "20px 24px 16px",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Info size={20} color="var(--accent)" />
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--text)" }}>Template Variables</h2>
              </div>
              <button
                onClick={() => setShowTemplateInfo(false)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 4,
                  borderRadius: 4,
                  color: "var(--text-muted)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Content */}
            <div style={{ padding: "20px 24px 24px", overflowY: "auto", maxHeight: "calc(80vh - 120px)" }}>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.5 }}>
                Use these placeholders in your prompt template to inject event data when the trigger fires.
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  { placeholder: "{{event.source}}", desc: "Connection alias", example: "discord-bot" },
                  { placeholder: "{{event.eventType}}", desc: "Event type string", example: "MESSAGE_CREATE" },
                  { placeholder: "{{event.id}}", desc: "Event ID number", example: "42" },
                  { placeholder: "{{event.receivedAt}}", desc: "ISO-8601 timestamp", example: "2026-02-21T12:00:00.000Z" },
                  { placeholder: "{{event.data}}", desc: "Full JSON payload (formatted)", example: '{"content": "hello", ...}' },
                  { placeholder: "{{event.data.field.path}}", desc: "Dot-notation into data object", example: "{{event.data.author.username}}" },
                ].map((item) => (
                  <div
                    key={item.placeholder}
                    style={{
                      padding: "10px 12px",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                    }}
                  >
                    <code style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--accent)" }}>{item.placeholder}</code>
                    <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.4 }}>
                      {item.desc}
                      <span style={{ opacity: 0.7 }}> — e.g. {item.example}</span>
                    </p>
                  </div>
                ))}
              </div>

              <div
                style={{
                  marginTop: 16,
                  padding: "10px 12px",
                  background: "color-mix(in srgb, var(--accent) 8%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
                  borderRadius: 8,
                  fontSize: 12,
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                }}
              >
                <strong style={{ color: "var(--text)" }}>Default behavior:</strong> When the prompt template is left empty, the trigger generates a default
                prompt containing the full event payload as JSON.
              </div>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  );
}
