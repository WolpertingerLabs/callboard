import { useState, useEffect } from "react";
// useOutletContext removed — agent is now passed as a prop
import { Plus, Play, Pause, CheckCircle, Clock, RotateCcw, Calendar, Trash2, X, Pencil, Zap, Loader2 } from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import ConfirmModal from "../../../components/ConfirmModal";
import { getAgentCronJobs, createAgentCronJob, updateAgentCronJob, deleteAgentCronJob, runAgentCronJob } from "../../../api";
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
 * Get the browser's timezone abbreviation (e.g., "EST", "PST").
 */
function getBrowserTzAbbr(): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date());
  return parts.find((p) => p.type === "timeZoneName")?.value || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Convert a time (hour:minute) from a source IANA timezone to the browser's local timezone.
 * Uses Intl to compute the correct offset, accounting for DST.
 */
function convertToLocalTime(cronHour: number, cronMinute: number, sourceTimezone: string): { hour: number; minute: number } {
  const now = new Date();

  // Start with a UTC date at the cron hour:minute
  const guessUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), cronHour, cronMinute, 0));

  // See what time this UTC instant shows in the source timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: sourceTimezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(guessUTC);
  const shownHour = parseInt(parts.find((p) => p.type === "hour")?.value || "0") % 24;
  const shownMinute = parseInt(parts.find((p) => p.type === "minute")?.value || "0");

  // The difference tells us the adjustment needed so the source timezone reads cronHour:cronMinute
  const wantedMinutes = cronHour * 60 + cronMinute;
  const shownMinutes = shownHour * 60 + shownMinute;
  let diffMinutes = wantedMinutes - shownMinutes;
  if (diffMinutes > 720) diffMinutes -= 1440;
  if (diffMinutes < -720) diffMinutes += 1440;

  // Adjust to get the correct UTC instant, then read browser-local time
  const correctedUTC = new Date(guessUTC.getTime() + diffMinutes * 60000);
  return { hour: correctedUTC.getHours(), minute: correctedUTC.getMinutes() };
}

/**
 * Lightweight cron-expression → human-readable string converter.
 * Converts times from the source (scheduling) timezone to the browser's local timezone.
 * Handles common patterns; falls back to the raw expression for exotic ones.
 */
function describeCron(expr: string, sourceTimezone: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;

  const [minute, hour, dom, month, dow] = parts;

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const formatTime12 = (h: number, m: number): string => {
    const period = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${m.toString().padStart(2, "0")} ${period}`;
  };

  const ordinal = (n: number): string => {
    const s = n % 100;
    if (s === 11 || s === 12 || s === 13) return `${n}th`;
    if (s % 10 === 1) return `${n}st`;
    if (s % 10 === 2) return `${n}nd`;
    if (s % 10 === 3) return `${n}rd`;
    return `${n}th`;
  };

  // Frequency-based patterns — no timezone conversion needed

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

  const cronHour = parseInt(hour);
  const cronMinute = parseInt(minute);
  if (isNaN(cronHour) || isNaN(cronMinute)) return expr;

  // Convert from source (scheduling) timezone → browser local timezone
  const local = convertToLocalTime(cronHour, cronMinute, sourceTimezone);
  const timeStr = formatTime12(local.hour, local.minute);
  const tzLabel = getBrowserTzAbbr();

  // Daily
  if (dom === "*" && month === "*" && dow === "*") {
    return `Daily at ${timeStr} ${tzLabel}`;
  }

  // Day-of-week patterns
  if (dom === "*" && month === "*" && dow !== "*") {
    if (dow === "1-5" || dow.toUpperCase() === "MON-FRI") return `Weekdays at ${timeStr} ${tzLabel}`;
    if (dow === "0,6" || dow.toUpperCase() === "SAT,SUN") return `Weekends at ${timeStr} ${tzLabel}`;

    const names = dow.split(",").map((d) => {
      const i = parseInt(d);
      return isNaN(i) ? d : dayNames[i] || d;
    });
    return `${names.join(", ")} at ${timeStr} ${tzLabel}`;
  }

  // Specific month + day (e.g. Feb 21)
  if (dom !== "*" && month !== "*" && dow === "*") {
    const mi = parseInt(month);
    const monthName = isNaN(mi) ? month : monthNames[mi - 1] || month;
    return `${monthName} ${dom} at ${timeStr} ${tzLabel}`;
  }

  // Day of month, every month
  if (dom !== "*" && month === "*" && dow === "*") {
    const d = parseInt(dom);
    return isNaN(d) ? expr : `${ordinal(d)} of every month at ${timeStr} ${tzLabel}`;
  }

  // Fallback: show time + raw expression
  return `${timeStr} ${tzLabel} — ${expr}`;
}

const typeConfig: Record<string, { color: string; icon: typeof Clock }> = {
  "one-off": { color: "var(--accent)", icon: Calendar },
  recurring: { color: "var(--success)", icon: RotateCcw },
  indefinite: { color: "var(--warning)", icon: Clock },
};

export default function CronJobs({ agent }: { agent: AgentConfig }) {
  const isMobile = useIsMobile();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Create form state
  const [formName, setFormName] = useState("");
  const [formSchedule, setFormSchedule] = useState("");
  const [formType, setFormType] = useState<CronJob["type"]>("recurring");
  const [formDescription, setFormDescription] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formSaving, setFormSaving] = useState(false);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<CronJob | null>(null);

  // Run now state
  const [runningJobId, setRunningJobId] = useState<string | null>(null);

  // Edit form state
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSchedule, setEditSchedule] = useState("");
  const [editType, setEditType] = useState<CronJob["type"]>("recurring");
  const [editDescription, setEditDescription] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editSaving, setEditSaving] = useState(false);

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

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteAgentCronJob(agent.alias, deleteTarget.id);
      setJobs((prev) => prev.filter((j) => j.id !== deleteTarget.id));
    } catch {
      // ignore
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleRunNow = async (job: CronJob) => {
    if (runningJobId) return;
    setRunningJobId(job.id);
    try {
      const updated = await runAgentCronJob(agent.alias, job.id);
      setJobs((prev) => prev.map((j) => (j.id === job.id ? updated : j)));
    } catch {
      // ignore
    } finally {
      setRunningJobId(null);
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

  const startEditing = (job: CronJob) => {
    setEditingJobId(job.id);
    setEditName(job.name);
    setEditSchedule(job.schedule);
    setEditType(job.type);
    setEditDescription(job.description);
    setEditPrompt(job.action?.prompt || "");
  };

  const cancelEditing = () => {
    setEditingJobId(null);
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingJobId || !editName.trim() || !editSchedule.trim() || !editDescription.trim()) return;

    setEditSaving(true);
    try {
      const updated = await updateAgentCronJob(agent.alias, editingJobId, {
        name: editName.trim(),
        schedule: editSchedule.trim(),
        type: editType,
        description: editDescription.trim(),
        action: { type: "start_session", prompt: editPrompt.trim() || undefined },
      });
      setJobs((prev) => prev.map((j) => (j.id === editingJobId ? updated : j)));
      setEditingJobId(null);
    } catch {
      // ignore
    } finally {
      setEditSaving(false);
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

  const scheduleTz = agent.userTimezone || agent.serverTimezone || "UTC";

  // Split jobs into user-defined and system-defined, with inactive jobs sorted to the bottom
  const statusOrder: Record<string, number> = { active: 0, paused: 1, completed: 2 };
  const sortByStatus = (a: CronJob, b: CronJob) => (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
  const userJobs = jobs.filter((j) => !j.isDefault).sort(sortByStatus);
  const systemJobs = jobs.filter((j) => j.isDefault).sort(sortByStatus);

  const renderJobCard = (job: CronJob) => {
    // If this job is being edited, show the edit form
    if (editingJobId === job.id) {
      return (
        <form
          key={job.id}
          onSubmit={handleEdit}
          style={{
            background: "var(--surface)",
            border: "1px solid var(--accent)",
            borderRadius: "var(--radius)",
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Job name" style={inputStyle} />
          <input
            type="text"
            value={editSchedule}
            onChange={(e) => setEditSchedule(e.target.value)}
            placeholder="Schedule (cron expression)"
            style={inputStyle}
          />
          <select value={editType} onChange={(e) => setEditType(e.target.value as CronJob["type"])} style={{ ...inputStyle, cursor: "pointer" }}>
            <option value="recurring">Recurring</option>
            <option value="one-off">One-off</option>
            <option value="indefinite">Indefinite</option>
          </select>
          <input type="text" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} placeholder="Description" style={inputStyle} />
          <textarea
            value={editPrompt}
            onChange={(e) => setEditPrompt(e.target.value)}
            placeholder="Prompt for the agent (optional)"
            rows={3}
            style={{ ...inputStyle, resize: "vertical", minHeight: 60 }}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={cancelEditing}
              style={{
                padding: "8px 14px",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                background: "transparent",
                color: "var(--text-muted)",
                border: "1px solid var(--border)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!editName.trim() || !editSchedule.trim() || !editDescription.trim() || editSaving}
              style={{
                padding: "8px 14px",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                background: "var(--accent)",
                color: "#fff",
                cursor: editSaving ? "not-allowed" : "pointer",
              }}
            >
              {editSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      );
    }

    // Display mode
    const sConf = statusConfig[job.status] || statusConfig.active;
    const tConf = typeConfig[job.type] || typeConfig.recurring;
    const StatusIcon = sConf.icon;
    const TypeIcon = tConf.icon;
    const canToggle = job.status !== "completed";
    const isDimmed = job.status === "paused" || job.status === "completed";

    return (
      <div
        key={job.id}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: isMobile ? "14px 16px" : "16px 20px",
          opacity: isDimmed ? 0.5 : 1,
          transition: "opacity 0.15s",
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
                System
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
          <span>{describeCron(job.schedule, scheduleTz)}</span>
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
            <button
              onClick={() => handleRunNow(job)}
              disabled={runningJobId === job.id}
              title="Run now"
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
                cursor: runningJobId === job.id ? "not-allowed" : "pointer",
                opacity: runningJobId === job.id ? 0.6 : 1,
              }}
              onMouseEnter={(e) => {
                if (runningJobId !== job.id) e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 10%, transparent)";
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {runningJobId === job.id ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Zap size={12} />}
              Run Now
            </button>
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
              onClick={() => startEditing(job)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "6px 10px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                background: "transparent",
                color: "var(--text-muted)",
                border: "1px solid var(--border)",
                cursor: "pointer",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--text-muted) 10%, transparent)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <Pencil size={12} />
            </button>
            {!job.isDefault && (
              <button
                onClick={() => setDeleteTarget(job)}
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
            )}
          </div>
        </div>
      </div>
    );
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
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
            Scheduled tasks and timed events
            <span style={{ marginLeft: 6, opacity: 0.7 }}>({getBrowserTzAbbr()})</span>
          </p>
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
          {/* User-defined jobs */}
          {userJobs.map(renderJobCard)}

          {/* System-defined jobs */}
          {systemJobs.length > 0 && (
            <>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  marginTop: userJobs.length > 0 ? 12 : 0,
                  marginBottom: 2,
                  paddingLeft: 2,
                }}
              >
                System
              </div>
              {systemJobs.map(renderJobCard)}
            </>
          )}
        </div>
      )}
      {/* Delete confirmation modal */}
      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Cron Job"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        confirmText="Delete"
        confirmStyle="danger"
      />
    </div>
  );
}
