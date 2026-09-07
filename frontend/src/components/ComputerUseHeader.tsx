import { Monitor, OctagonX } from "lucide-react";
import type { ComputerUseController } from "../hooks/useComputerUseController";
import { isPending, isTerminal } from "../hooks/useComputerUseController";
import "./ComputerUsePanel.css";

export default function ComputerUseHeader({ controller, viewOpen = false }: { controller: ComputerUseController; viewOpen?: boolean }) {
  // Explicit viewing offers emergency discovery without recording computer use.
  // Closing it must not hide an in-flight Stop or an unresolved retry failure.
  if (!controller.hasUsage && !viewOpen && !controller.stopping && !controller.stopError) return null;
  const { status, statusError, stopping, stopError, stopAll } = controller;
  const sessions = status?.sessions.filter((session) => !isTerminal(session)) ?? [];
  const active = sessions.filter((session) => ["active", "ready", "running"].includes(session.state)).length;
  const waiting = sessions.filter(isPending).length;
  const other = sessions.length - active - waiting;
  const agent = sessions.filter((session) => session.controller === "agent").length;
  const human = sessions.filter((session) => session.controller === "human").length;
  // Permission denial does not imply that existing sessions have stopped.
  const state = statusError
    ? status
      ? "Last known"
      : "Unavailable"
    : !status
      ? "Checking…"
      : status.permission === "deny"
        ? "Disabled"
        : !sessions.length
          ? "Idle"
          : "";
  const details = [
    "Browser & Computer Control",
    statusError
      ? status
        ? "Status unavailable (last known)"
        : "Status unavailable (no known state)"
      : !status
        ? "Checking status"
        : status.permission === "deny"
          ? "Disabled for new control"
          : "Status current",
    ...(status
      ? [`${active} active · ${waiting} waiting for approval${other ? ` · ${other} other` : ""}`, `controllers: agent ${agent} / human ${human}`]
      : []),
  ].join(": ");
  return (
    <div className="computer-use-header" aria-label="Browser & Computer Control">
      <span className="computer-use-summary" role="status" aria-label={details} title={details}>
        <Monitor size={14} aria-hidden="true" />
        {state && (
          <span className="computer-use-badge" data-warning={!!statusError}>
            {state}
          </span>
        )}
        {!!sessions.length && (
          <>
            <span className="computer-use-badge" data-warning={waiting > 0}>
              {active} active · {waiting} waiting
            </span>
            {other > 0 && <span className="computer-use-badge">{other} other</span>}
            {agent > 0 && <span className="computer-use-badge">Agent {agent}</span>}
            {human > 0 && <span className="computer-use-badge">Human {human}</span>}
            {!agent && !human && <span className="computer-use-badge">No controller</span>}
          </>
        )}
      </span>
      <button
        className="computer-use-stop"
        onClick={() => void stopAll()}
        disabled={stopping}
        aria-label="Stop computer control"
        title="Stop computer control — all browser and computer sessions"
      >
        <OctagonX size={14} aria-hidden="true" />
        {stopping ? "Stopping…" : "Stop computer"}
      </button>
      {stopError && <span role="alert">{stopError}</span>}
    </div>
  );
}
