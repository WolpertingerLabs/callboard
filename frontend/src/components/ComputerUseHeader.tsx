import type { ComputerUseController } from "../hooks/useComputerUseController";
import { isPending, isTerminal } from "../hooks/useComputerUseController";
import "./ComputerUsePanel.css";

export default function ComputerUseHeader({ controller }: { controller: ComputerUseController }) {
  const { status, statusError, stopping, stopError, stopAll } = controller;
  const sessions = status?.sessions.filter((session) => !isTerminal(session)) ?? [];
  const active = sessions.filter((session) => ["active", "ready", "running"].includes(session.state)).length;
  const waiting = sessions.filter(isPending).length;
  return (
    <div className="computer-use-header" aria-label="Browser & Computer Control">
      <span role="status">
        Browser &amp; Computer Control: {statusError ? "status unavailable (last known) · " : !status ? "checking status · " : ""}
        {status && (
          <>
            {active} active · {waiting} waiting{sessions.length > active + waiting ? ` · ${sessions.length - active - waiting} other` : ""} · controllers: agent{" "}
            {sessions.filter((s) => s.controller === "agent").length} / human {sessions.filter((s) => s.controller === "human").length}
          </>
        )}
      </span>
      <button onClick={() => void stopAll()} disabled={stopping}>
        Stop computer control
      </button>
      {stopError && <span role="alert">{stopError}</span>}
    </div>
  );
}
