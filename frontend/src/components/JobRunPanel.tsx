import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, XCircle, Circle, CircleDot, Loader2, Clock, MessageSquare, Ban, Pause, Play, RotateCcw } from "lucide-react";
import { getJobRun, respondJobApproval, cancelJobRun, pauseJobRun, resumeJobRun, retryJobStep } from "../api";
import type { JobRun, JobRunStatus, JobStep } from "../api";

const TERMINAL_STATUSES: JobRunStatus[] = ["succeeded", "failed", "cancelled"];

export const JOB_RUN_STATUS_META: Record<JobRunStatus, { label: string; color: string }> = {
  running: { label: "Running", color: "var(--accent)" },
  waiting_approval: { label: "Waiting for approval", color: "var(--warning)" },
  waiting_event: { label: "Waiting for event", color: "var(--badge-info)" },
  sleeping: { label: "Sleeping", color: "var(--badge-info)" },
  paused: { label: "Paused", color: "var(--text-muted)" },
  succeeded: { label: "Succeeded", color: "var(--success)" },
  failed: { label: "Failed", color: "var(--danger)" },
  cancelled: { label: "Cancelled", color: "var(--text-muted)" },
};

interface JobRunPanelProps {
  runId: string;
  /** Compact mode for embedding (settings runs table expansion). */
  compact?: boolean;
}

/**
 * Live view of a job run: status, step progress, approval actions, history.
 * Polls the run every 4s while it is in a non-terminal status.
 */
export default function JobRunPanel({ runId, compact }: JobRunPanelProps) {
  const navigate = useNavigate();
  const [run, setRun] = useState<JobRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [comment, setComment] = useState("");

  const refresh = useCallback(() => {
    return getJobRun(runId)
      .then((r) => {
        setRun(r);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, [runId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!run || TERMINAL_STATUSES.includes(run.status)) return;
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [run, refresh]);

  const act = async (fn: () => Promise<JobRun>) => {
    setActing(true);
    setError(null);
    try {
      setRun(await fn());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActing(false);
    }
  };

  if (!run) {
    return <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>{error || "Loading job run…"}</div>;
  }

  const statusMeta = JOB_RUN_STATUS_META[run.status];
  const approvalMessage = run.status === "waiting_approval" ? run.activeStep?.pendingResult?.summary : undefined;

  // Latest history entry per step, for status icons and detail lines.
  const latestByStep = new Map<string, JobRun["history"][number]>();
  for (const entry of run.history) latestByStep.set(entry.stepId, entry);

  const stepIcon = (step: JobStep) => {
    const latest = latestByStep.get(step.id);
    const isCurrent = run.currentStepId === step.id && !TERMINAL_STATUSES.includes(run.status);
    if (isCurrent) {
      if (run.status === "running") return <Loader2 size={15} style={{ color: "var(--accent)", animation: "spin 1.5s linear infinite" }} />;
      if (run.status === "waiting_approval") return <Clock size={15} style={{ color: "var(--warning)" }} />;
      if (run.status === "sleeping" || run.status === "waiting_event") return <Clock size={15} style={{ color: "var(--badge-info)" }} />;
      return <CircleDot size={15} style={{ color: "var(--text-muted)" }} />;
    }
    if (run.status === "failed" && run.currentStepId === step.id) return <XCircle size={15} style={{ color: "var(--danger)" }} />;
    if (!latest) return <Circle size={15} style={{ color: "var(--text-muted)", opacity: 0.5 }} />;
    if (["error", "rejected", "timeout", "failed"].includes(latest.result) && run.currentStepId === step.id) {
      return <XCircle size={15} style={{ color: "var(--danger)" }} />;
    }
    return <CheckCircle2 size={15} style={{ color: "var(--success)" }} />;
  };

  return (
    <div style={{ padding: compact ? 12 : 16, fontSize: 13, color: "var(--text)" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{ fontSize: compact ? 14 : 16, fontWeight: 600 }}>{run.jobName}</span>
        <span
          style={{
            padding: "2px 10px",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
            color: statusMeta.color,
            border: `1px solid ${statusMeta.color}`,
          }}
        >
          {statusMeta.label}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{run.runId}</span>
        <span style={{ flex: 1 }} />
        {!TERMINAL_STATUSES.includes(run.status) && (
          <>
            {["sleeping", "waiting_event", "waiting_approval"].includes(run.status) && (
              <button onClick={() => act(() => pauseJobRun(run.runId))} disabled={acting} style={actionButtonStyle}>
                <Pause size={13} /> Pause
              </button>
            )}
            {run.status === "paused" && (
              <button onClick={() => act(() => resumeJobRun(run.runId))} disabled={acting} style={actionButtonStyle}>
                <Play size={13} /> Resume
              </button>
            )}
            <button onClick={() => window.confirm("Cancel this job run? This cannot be undone.") && act(() => cancelJobRun(run.runId))} disabled={acting} style={{ ...actionButtonStyle, color: "var(--danger)", borderColor: "var(--danger)" }}>
              <Ban size={13} /> Cancel
            </button>
          </>
        )}
        {run.status === "failed" && (
          <button onClick={() => act(() => retryJobStep(run.runId))} disabled={acting} style={actionButtonStyle}>
            <RotateCcw size={13} /> Retry step
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: "8px 12px", borderRadius: 6, background: "var(--danger-bg)", border: "1px solid var(--danger-border)", color: "var(--danger)", marginBottom: 12 }}>
          {error}
        </div>
      )}

      {run.error && (
        <div style={{ padding: "8px 12px", borderRadius: 6, background: "var(--danger-bg)", border: "1px solid var(--danger-border)", color: "var(--danger)", marginBottom: 12 }}>
          {run.error}
        </div>
      )}

      {/* Approval prompt */}
      {run.status === "waiting_approval" && (
        <div style={{ padding: 12, borderRadius: 8, border: "1px solid var(--warning)", marginBottom: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--warning)" }}>Approval needed</div>
          {approvalMessage && <div style={{ whiteSpace: "pre-wrap", marginBottom: 10, maxHeight: 240, overflow: "auto" }}>{approvalMessage}</div>}
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional comment…"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 13,
              marginBottom: 8,
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => act(() => respondJobApproval(run.runId, "approve", comment || undefined))}
              disabled={acting}
              style={{ ...actionButtonStyle, background: "var(--success)", color: "var(--text-on-accent)", border: "none", fontWeight: 600 }}
            >
              Approve
            </button>
            <button
              onClick={() => act(() => respondJobApproval(run.runId, "reject", comment || undefined))}
              disabled={acting}
              style={{ ...actionButtonStyle, background: "var(--danger)", color: "var(--text-on-accent)", border: "none", fontWeight: 600 }}
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {/* Inputs */}
      {Object.keys(run.inputs).length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 4, color: "var(--text-muted)", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4 }}>Inputs</div>
          {Object.entries(run.inputs).map(([key, value]) => (
            <div key={key} style={{ display: "flex", gap: 8, marginBottom: 2 }}>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", flexShrink: 0 }}>{key}:</span>
              <span style={{ wordBreak: "break-word", whiteSpace: "pre-wrap", maxHeight: 60, overflow: "hidden", textOverflow: "ellipsis" }}>{value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Stepper */}
      <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--text-muted)", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4 }}>Steps</div>
      <div style={{ display: "flex", flexDirection: "column", marginBottom: 14 }}>
        {run.definition.steps.map((step, i) => {
          const latest = latestByStep.get(step.id);
          const isCurrent = run.currentStepId === step.id && !["succeeded"].includes(run.status);
          const loopCount = run.loopCounts[step.id];
          const stepEntries = run.history.filter((h) => h.stepId === step.id);
          return (
            <div key={step.id} style={{ display: "flex", gap: 10 }}>
              {/* Icon + connector */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 16, flexShrink: 0 }}>
                <div style={{ paddingTop: 3 }}>{stepIcon(step)}</div>
                {i < run.definition.steps.length - 1 && <div style={{ width: 1, flex: 1, background: "var(--border)", minHeight: 10 }} />}
              </div>
              <div style={{ paddingBottom: 14, minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: isCurrent ? 700 : 600 }}>{step.name || step.id}</span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 5px" }}>{step.type}</span>
                  {isCurrent && run.activeStep && run.activeStep.attempt > 1 && (
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>attempt {run.activeStep.attempt}</span>
                  )}
                  {loopCount !== undefined && <span style={{ fontSize: 11, color: "var(--badge-trigger)" }}>loops: {loopCount}</span>}
                  {isCurrent && run.nextWakeAt && ["sleeping", "waiting_approval", "waiting_event"].includes(run.status) && (
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>wakes {new Date(run.nextWakeAt).toLocaleString()}</span>
                  )}
                </div>
                {latest?.detail && (
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {latest.detail}
                  </div>
                )}
                {stepEntries.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                    {stepEntries.map((entry, j) => (
                      <span key={j} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted)" }}>
                        <span>{entry.result}</span>
                        {entry.chatId && (
                          <button
                            onClick={() => navigate(`/chat/${entry.chatId}`)}
                            title="Open step chat"
                            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--accent)", display: "inline-flex", alignItems: "center" }}
                          >
                            <MessageSquare size={12} />
                          </button>
                        )}
                        {j < stepEntries.length - 1 && <span>·</span>}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        Started {new Date(run.createdAt).toLocaleString()}
        {run.endedAt && <> · ended {new Date(run.endedAt).toLocaleString()}</>} · {run.sessionsSpawned} session{run.sessionsSpawned === 1 ? "" : "s"} spawned · job
        version {run.definition.version}
      </div>
    </div>
  );
}

const actionButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "5px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 12,
  cursor: "pointer",
};
