import { Workflow } from "lucide-react";
import type { JobRunListItem } from "../api";
import { JOB_RUN_STATUS_META } from "./JobRunPanel";

export const ACTIVE_JOB_RUN_STATUSES = ["running", "waiting_approval", "waiting_event", "sleeping"];

interface Props {
  run: JobRunListItem;
  isActive?: boolean;
  onClick: () => void;
  /** Current time in ms, passed from parent to avoid impure render calls */
  now: number;
}

function formatRelativeTime(isoDate: string, now: number): string {
  const diff = now - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function JobListItem({ run, isActive, onClick, now }: Props) {
  const statusMeta = JOB_RUN_STATUS_META[run.status];
  const isRunActive = ACTIVE_JOB_RUN_STATUSES.includes(run.status);

  return (
    <div
      onClick={onClick}
      style={{
        padding: "14px 20px",
        borderBottom: "1px solid var(--chatlist-item-border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: "pointer",
        background: isActive ? "var(--chatlist-item-active-bg)" : "var(--chatlist-item-bg)",
        borderLeft: isActive ? "3px solid var(--chatlist-item-active-border)" : "3px solid transparent",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        {/* Row 1: running dot + run title (or job name) + status pill */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {run.status === "running" && (
            <span
              title="Running"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--success)",
                flexShrink: 0,
                boxShadow: "0 0 4px var(--success)",
              }}
            />
          )}
          <Workflow size={14} style={{ color: "var(--chatlist-icon)", flexShrink: 0 }} />
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--chatlist-item-title-text)",
            }}
          >
            {run.title || run.jobName}
          </div>
          {statusMeta && (
            <span
              style={{
                padding: "1px 8px",
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 600,
                color: statusMeta.color,
                border: `1px solid ${statusMeta.color}`,
                flexShrink: 0,
              }}
            >
              {statusMeta.label}
            </span>
          )}
        </div>

        {/* Row 2: job name (when a custom title is shown above) + run id */}
        <div
          title={run.runId}
          style={{
            fontSize: 12,
            color: "var(--chatlist-item-path-text)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {run.title ? `${run.jobName} · ${run.runId}` : run.runId}
        </div>

        {/* Row 3: current stage of the run */}
        {(isRunActive || run.status === "paused" || run.status === "failed") && run.currentStepIndex && (
          <div
            title={run.currentStepName}
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            Step {run.currentStepIndex}/{run.stepCount}: {run.currentStepName}
            {run.currentStepType ? ` (${run.currentStepType})` : ""}
          </div>
        )}

        {/* Failed runs surface the error */}
        {run.error && (
          <div
            title={run.error}
            style={{
              fontSize: 12,
              color: "var(--danger)",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {run.error}
          </div>
        )}

        {/* Row 4: timestamps */}
        <div style={{ fontSize: 11, color: "var(--chatlist-item-time-text)", marginTop: 2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span title={`Run started: ${new Date(run.createdAt).toLocaleString()}`}>Started {formatRelativeTime(run.createdAt, now)}</span>
          <span style={{ opacity: 0.5 }}>&middot;</span>
          <span title={`Updated: ${new Date(run.updatedAt).toLocaleString()}`}>Updated {formatRelativeTime(run.updatedAt, now)}</span>
          {run.nextWakeAt && isRunActive && (
            <>
              <span style={{ opacity: 0.5 }}>&middot;</span>
              <span title={`Next wake: ${new Date(run.nextWakeAt).toLocaleString()}`}>Wakes {new Date(run.nextWakeAt).toLocaleTimeString()}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
