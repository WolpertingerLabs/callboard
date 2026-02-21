import { useState, useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import { Plus, Play, Pause, CheckCircle, Clock, RotateCcw, Calendar, Trash2, X } from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { getAgentCronJobs, createAgentCronJob, updateAgentCronJob, deleteAgentCronJob } from "../../../api";
import type { CronJob, AgentConfig } from "../../../api";

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

function timeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff < 0) return "Overdue";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

const statusConfig: Record<string, { color: string; icon: typeof Play; label: string }> = {
  active: { color: "var(--success)", icon: Play, label: "Active" },
  paused: { color: "var(--warning)", icon: Pause, label: "Paused" },
  completed: { color: "var(--text-muted)", icon: CheckCircle, label: "Completed" },
};

/**
 * Lightweight cron-expression → human-readable string converter.
 * Handles common patterns; falls back to the raw expression for exotic ones.
 */
function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;

  const [minute, hour, dom, month, dow] = parts;

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const formatTime = (h: string, m: string): string | null => {
    const hi = parseInt(h);
    const mi = parseInt(m);
    if (isNaN(hi) || isNaN(mi)) return null;
    const period = hi >= 12 ? "PM" : "AM";
    const h12 = hi === 0 ? 12 : hi > 12 ? hi - 12 : hi;
    return `${h12}:${mi.toString().padStart(2, "0")} ${period}`;
  };

  const ordinal = (n: number): string => {
    const s = n % 100;
    if (s === 11 || s === 12 || s === 13) return `${n}th`;
    if (s % 10 === 1) return `${n}st`;
    if (s % 10 === 2) return `${n}nd`;
    if (s % 10 === 3) return `${n}rd`;
    return `${n}th`;
  };

  // Every minute
  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "Every minute";
  }

  // Every N minutes
  if (minute.startsWith("*/") && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Every ${minute.slice(2)} minutes`;
  }

  // Every hour (at minute 0 or specific minute)
  if (hour === "*" && dom === "*" && month === "*" && dow === "*") {
    if (minute === "0") return "Every hour";
    return `Every hour at :${minute.padStart(2, "0")}`;
  }

  // Every N hours
  if (hour.startsWith("*/") && dom === "*" && month === "*" && dow === "*") {
    const n = hour.slice(2);
    return minute === "0" ? `Every ${n} hours` : `Every ${n} hours at :${minute.padStart(2, "0")}`;
  }

  // From here we need a concrete hour — bail on wildcards / step values in hour
  if (hour.includes("*") || hour.includes("/")) return expr;

  const timeStr = formatTime(hour, minute);
  if (!timeStr) return expr;

  // Daily
  if (dom === "*" && month === "*" && dow === "*") {
    return `Daily at ${timeStr} UTC`;
  }

  // Day-of-week patterns
  if (dom === "*" && month === "*" && dow !== "*") {
    if (dow === "1-5" || dow.toUpperCase() === "MON-FRI") return `Weekdays at ${timeStr} UTC`;
    if (dow === "0,6" || dow.toUpperCase() === "SAT,SUN") return `Weekends at ${timeStr} UTC`;

    const names = dow.split(",").map((d) => {
      const i = parseInt(d);
      return isNaN(i) ? d : dayNames[i] || d;
    });
    return `${names.join(", ")} at ${timeStr} UTC`;
  }

  // Specific month + day (e.g. Feb 21)
  if (dom !== "*" && month !== "*" && dow === "*") {
    const mi = parseInt(month);
    const monthName = isNaN(mi) ? month : monthNames[mi - 1] || month;
    return `${monthName} ${dom} at ${timeStr} UTC`;
  }

  // Day of month, every month
  if (dom !== "*" && month === "*" && dow === "*") {
    const d = parseInt(dom);
    return isNaN(d) ? expr : `${ordinal(d)} of every month at ${timeStr} UTC`;
  }

  // Fallback: show time + raw expression
  return `${timeStr} UTC — ${expr}`;
}

const typeConfig: Record<string, { color: string; icon: typeof Clock }> = {
  "one-off": { color: "var(--accent)", icon: Calendar },
  recurring: { color: "var(--success)", icon: RotateCcw },
  indefinite: { color: "var(--warning)", icon: Clock },
};

export default function CronJobs() {
  const { agent } = useOutletContext<{ agent: AgentConfig }>();
  const isMobile = useIsMobile();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formSchedule, setFormSchedule] = useState("");
  const [formType, setFormType] = useState<CronJob["type"]>("recurring");
  const [formDescription, setFormDescription] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formSaving, setFormSaving] = useState(false);

  const loadJobs = () => {
    setLoading(true);
    getAgentCronJobs(agent.alias)
      .then(setJobs)
      .catch(() => setJobs([]))
      .finally(() => setLoading(false));
  };

  useEffect(loadJobs, [agent.alias]);

  const toggleJob = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "paused" : "active";
    try {
      const updated = await updateAgentCronJob(agent.alias, id, { status: newStatus });
      setJobs((prev) => prev.map((j) => (j.id === id ? updated : j)));
    } catch {
      // ignore
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteAgentCronJob(agent.alias, id);
      setJobs((prev) => prev.filter((j) => j.id !== id));
    } catch {
      // ignore
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim() || !formSchedule.trim() || !formDescription.trim()) return;

    setFormSaving(true);
    try {
      const job = await createAgentCronJob(agent.alias, {
        name: formName.trim(),
        schedule: formSchedule.trim(),
        type: formType,
        status: "active",
        description: formDescription.trim(),
        action: { type: "start_session", prompt: formPrompt.trim() || undefined },
      });
      setJobs((prev) => [...prev, job]);
      setShowForm(false);
      setFormName("");
      setFormSchedule("");
      setFormType("recurring");
      setFormDescription("");
      setFormPrompt("");
    } catch {
      // ignore
    } finally {
      setFormSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "var(--bg)",
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
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Cron Jobs</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>Scheduled tasks and timed events</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
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
          {!isMobile && (showForm ? "Cancel" : "New Job")}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <form
          onSubmit={handleCreate}
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
          <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Job name" style={inputStyle} />
          <input
            type="text"
            value={formSchedule}
            onChange={(e) => setFormSchedule(e.target.value)}
            placeholder="Schedule (e.g. Every weekday at 9:00 AM)"
            style={inputStyle}
          />
          <select value={formType} onChange={(e) => setFormType(e.target.value as CronJob["type"])} style={{ ...inputStyle, cursor: "pointer" }}>
            <option value="recurring">Recurring</option>
            <option value="one-off">One-off</option>
            <option value="indefinite">Indefinite</option>
          </select>
          <input type="text" value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="Description" style={inputStyle} />
          <textarea
            value={formPrompt}
            onChange={(e) => setFormPrompt(e.target.value)}
            placeholder="Prompt for the agent (optional)"
            rows={3}
            style={{ ...inputStyle, resize: "vertical", minHeight: 60 }}
          />
          <button
            type="submit"
            disabled={!formName.trim() || !formSchedule.trim() || !formDescription.trim() || formSaving}
            style={{
              background: "var(--accent)",
              color: "#fff",
              padding: "10px 18px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              alignSelf: "flex-end",
            }}
          >
            {formSaving ? "Creating..." : "Create Job"}
          </button>
        </form>
      )}

      {/* Job list */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--text-muted)", fontSize: 14 }}>Loading cron jobs...</div>
      ) : jobs.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--text-muted)", fontSize: 14 }}>
          No cron jobs yet. Create one to schedule automated tasks.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {jobs.map((job) => {
            const sConf = statusConfig[job.status] || statusConfig.active;
            const tConf = typeConfig[job.type] || typeConfig.recurring;
            const StatusIcon = sConf.icon;
            const TypeIcon = tConf.icon;
            const canToggle = job.status !== "completed";

            return (
              <div
                key={job.id}
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: isMobile ? "14px 16px" : "16px 20px",
                }}
              >
                {/* Top row: name, status, type */}
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
                  <h3 style={{ fontSize: 15, fontWeight: 600 }}>
                    {job.name}
                    {job.isDefault && (
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: 10,
                          fontWeight: 500,
                          color: "var(--text-muted)",
                          background: "var(--bg)",
                          padding: "2px 6px",
                          borderRadius: 4,
                          border: "1px solid var(--border)",
                          verticalAlign: "middle",
                        }}
                      >
                        Default
                      </span>
                    )}
                  </h3>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 11,
                        fontWeight: 500,
                        color: tConf.color,
                        background: `color-mix(in srgb, ${tConf.color} 12%, transparent)`,
                        padding: "3px 8px",
                        borderRadius: 6,
                      }}
                    >
                      <TypeIcon size={12} />
                      {job.type}
                    </span>
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
                </div>

                {/* Schedule */}
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
                  <Clock size={13} />
                  <span>{describeCron(job.schedule)}</span>
                  <span style={{ opacity: 0.5 }}>({job.schedule})</span>
                </div>

                {/* Description */}
                <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 10 }}>{job.description}</p>

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
                    {job.lastRun && <span>Last run: {timeAgo(job.lastRun)}</span>}
                    {job.nextRun && <span style={{ color: "var(--text)" }}>Next run: {timeUntil(job.nextRun)}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {canToggle && (
                      <button
                        onClick={() => toggleJob(job.id, job.status)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "6px 12px",
                          borderRadius: 6,
                          fontSize: 12,
                          fontWeight: 500,
                          background: "transparent",
                          color: job.status === "active" ? "var(--warning)" : "var(--success)",
                          border: `1px solid color-mix(in srgb, ${job.status === "active" ? "var(--warning)" : "var(--success)"} 30%, transparent)`,
                          transition: "background 0.15s",
                          cursor: "pointer",
                        }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.background = `color-mix(in srgb, ${job.status === "active" ? "var(--warning)" : "var(--success)"} 10%, transparent)`)
                        }
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        {job.status === "active" ? <Pause size={12} /> : <Play size={12} />}
                        {job.status === "active" ? "Pause" : "Resume"}
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(job.id)}
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
    </div>
  );
}
