import { useCallback, useEffect, useRef, useState } from "react";
import type { ComputerUseAction, ComputerUseKind, ComputerUseObservation, ComputerUseSession, ComputerUseStatus } from "shared/types/computerUse.js";
import type { PermissionLevel } from "shared/types/permissions.js";
import { computerUseClient as client } from "../api/computerUse";
import "./ComputerUsePanel.css";

const terminal = (session: ComputerUseSession) => ["stopped", "revoked", "closed", "failed", "expired"].includes(session.state);
const pending = (session: ComputerUseSession) => ["pending", "awaiting_approval", "approval_required", "pending_approval"].includes(session.state);

export function framePoint(clientX: number, clientY: number, rect: Pick<DOMRect, "left" | "top" | "width" | "height">, width: number, height: number) {
  return {
    x: Math.max(0, Math.min(width - 1, Math.floor(((clientX - rect.left) * width) / rect.width))),
    y: Math.max(0, Math.min(height - 1, Math.floor(((clientY - rect.top) * height) / rect.height))),
  };
}

/** A viewer is never a desktop target. Opening, approving and takeover are separate,
 * explicit actions. Screenshots remain in memory and are cleared on close/control changes.
 */
export default function ComputerUsePanel({
  chatId,
  permission = "deny",
  onPermissions,
}: {
  chatId: string;
  permission?: PermissionLevel;
  onPermissions?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [kind, setKind] = useState<ComputerUseKind>("browser");
  const [selected, setSelected] = useState("");
  const [observation, setObservation] = useState<(ComputerUseObservation & { sessionId: string; controller: ComputerUseSession["controller"] }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [pointerMode, setPointerMode] = useState<"click" | "right" | "move" | "drag">("click");
  const [timeline, setTimeline] = useState<string[]>([]);
  const sequence = useRef(0);
  const abort = useRef<AbortController>();
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const session = status?.sessions.find((item) => item.id === selected) ?? status?.sessions[0];
  const capability = status?.capabilities.find((item) => item.kind === kind);
  const denied = permission === "deny" || status?.permission === "deny";
  const active =
    session && ["active", "ready", "running"].includes(session.state) && status?.capabilities.some((item) => item.kind === session.kind && item.available);
  const frame =
    !denied && active && observation?.sessionId === session.id && observation.generation === session.generation && observation.controller === session.controller
      ? observation.frame
      : null;
  const human = !!active && session.controller === "human";
  const canAct = human && !!frame && !busy && !denied;

  const refresh = useCallback(async (signal: AbortSignal) => client.status(chatId, signal), [chatId]);

  // Serialize normal operations; emergency stop/revoke can supersede any in-flight
  // request. The server remains responsible for cancelling already accepted work.
  const run = useCallback(
    async (label: string, work: (signal: AbortSignal) => Promise<ComputerUseObservation | void>, keepFrame = false) => {
      const ticket = ++sequence.current;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setBusy(true);
      setError("");
      if (!keepFrame) setObservation(null);
      try {
        const nextFrame = await work(controller.signal);
        const next = await refresh(controller.signal);
        if (ticket !== sequence.current) return;
        setStatus(next);
        if (nextFrame && session) setObservation({ ...nextFrame, sessionId: session.id, controller: session.controller });
        setTimeline((items) => [`${new Date().toLocaleTimeString()} — ${label}`, ...items].slice(0, 20));
      } catch (err) {
        if (ticket !== sequence.current) return;
        setObservation(null);
        setStatus((previous) => (previous ? { ...previous, capabilities: [], permission: "deny" } : null)); // Keep emergency controls reachable.
        setError(err instanceof Error ? err.message : "Computer control failed. Retry status or check server configuration.");
      } finally {
        if (ticket === sequence.current) setBusy(false);
      }
    },
    [refresh, session],
  );

  useEffect(() => {
    setObservation(null);
    setStatus(null);
    setError("");
    setText("");
    setUrl("");
    if (!expanded) return;
    const ticket = ++sequence.current;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    refresh(controller.signal)
      .then((next) => {
        if (ticket === sequence.current) setStatus(next);
      })
      .catch((err: unknown) => {
        if (ticket === sequence.current) setError(err instanceof Error ? err.message : "Could not load capabilities. Retry status.");
      })
      .finally(() => {
        if (ticket === sequence.current) setBusy(false);
      });
    return () => {
      ++sequence.current;
      controller.abort();
      abort.current?.abort();
    };
  }, [chatId, expanded, permission, refresh]);

  // Status only: never capture a screen silently. Invalidate stale displayed frames
  // when another viewer/agent changes the generation, controller or permission.
  useEffect(() => {
    if (!expanded || busy) return;
    let alive = true;
    let inFlight = false;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      const ticket = sequence.current;
      refresh(controller.signal)
        .then((next) => {
          if (alive && ticket === sequence.current) setStatus(next);
        })
        .catch(() => {
          if (alive && ticket === sequence.current) {
            setObservation(null);
            setStatus((previous) => (previous ? { ...previous, capabilities: [], permission: "deny" } : null));
            setError("Status connection lost. Retry status before controlling the target.");
          }
        })
        .finally(() => {
          inFlight = false;
        });
    }, 3000);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [expanded, busy, refresh]);

  useEffect(() => {
    setObservation((previous) =>
      previous &&
      !denied &&
      active &&
      session &&
      previous.sessionId === session.id &&
      previous.generation === session.generation &&
      previous.controller === session.controller
        ? previous
        : null,
    );
    dragStart.current = null;
  }, [denied, active, session]);

  // Preview is explicitly opt-in, human-only presentation. These frames are not
  // added to model context; cu_observe is the separate model image path.
  useEffect(() => {
    if (!preview || !expanded || denied || !active || !session || busy) return;
    const controller = new AbortController();
    let alive = true;
    let inFlight = false;
    const capture = async () => {
      if (inFlight) return;
      inFlight = true;
      const ticket = sequence.current;
      try {
        const result = await client.observe(chatId, session.id, controller.signal);
        if (alive && ticket === sequence.current) setObservation({ ...result, sessionId: session.id, controller: session.controller });
      } catch {
        if (alive) { setObservation(null); setPreview(false); }
      } finally { inFlight = false; }
    };
    const timer = window.setInterval(() => { void capture(); }, 1000);
    void capture();
    return () => { alive = false; controller.abort(); window.clearInterval(timer); };
  }, [preview, expanded, denied, active, session, busy, chatId]);

  const hideScreenshot = () => {
    setPreview(false);
    ++sequence.current;
    abort.current?.abort();
    setBusy(false);
    setObservation(null);
    setText("");
    dragStart.current = null;
  };

  const control = (operation: "takeover" | "resume" | "stop" | "revoke" | "approve") => {
    if (!session) return;
    void run(operation, async (signal) => {
      await client.control(chatId, session.id, operation, session.generation, signal);
    });
  };
  const action = (value: ComputerUseAction) => {
    if (!canAct || !session || !frame) return;
    setText("");
    void run(`Manual ${value.type}`, async (signal) => {
      await client.action(
        chatId,
        session.id,
        {
          action: value,
          expectedGeneration: session.generation,
          frameId: frame.id,
          requestId: crypto.randomUUID(),
        },
        signal,
      );
      return client.observe(chatId, session.id, signal);
    });
  };

  return (
    <section className="computer-use-panel" aria-label="Browser & Computer Control">
      <button className="computer-use-heading" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? "▾" : "▸"} Browser &amp; Computer Control
      </button>
      {expanded && (
        <div className="computer-use-body">
          <p>Controls Callboard&apos;s browser and desktop tools. Agents with unrestricted code execution may still run their own automation.</p>
          <p>Tools run on the configured service target, not on this viewer&apos;s computer. Model visual capability is not established by this viewer.</p>
          <div className="computer-use-controls">
            <label>
              Target{" "}
              <select value={kind} onChange={(event) => setKind(event.target.value as ComputerUseKind)}>
                <option value="browser">Managed browser</option>
                <option value="native">Native desktop (service host)</option>
              </select>
            </label>
            <button
              disabled={busy || denied || capability?.available !== true}
              onClick={() => {
                void run("Enable requested", async (signal) => {
                  const opened = await client.open(chatId, kind, signal);
                  if (!signal.aborted) setSelected(opened.session.id);
                });
              }}
            >
              Enable
            </button>
            <button disabled={busy} onClick={() => void run("Status refreshed", async () => {}, true)}>
              Retry status
            </button>
            {onPermissions && <button onClick={onPermissions}>Chat permissions</button>}
          </div>
          {(kind === "native" || session?.kind === "native") && (
            <p role="note">
              <strong>Same-machine native control:</strong> this targets the Callboard service host&apos;s existing desktop and applications. It requires a
              configured display and OS capture/input consent. A remote viewer does not grant control of its own desktop. Stopping control does not close your
              applications.
            </p>
          )}
          {denied && (
            <p role="status">Computer control is denied. Set Browser &amp; Computer Control to Ask or Allow in chat permissions, then retry status.</p>
          )}
          {!capability?.available && (
            <p role="status">
              {capability?.reason ??
                "Target readiness has not been confirmed. Retry status; configure the browser runtime or a supported native display on the service host."}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {status?.sessions.filter((item) => pending(item) && item.id !== session?.id).map((item) => (
            <aside key={item.id} aria-label="Pending computer approval">
              <p>{item.reason ?? `Approve access to ${item.targetLabel ?? item.kind}`}</p>
              <button disabled={busy || denied} onClick={() => void run("Request approved", async (signal) => { await client.control(chatId, item.id, "approve", item.generation, signal); })}>Confirm request</button>
              <button onClick={() => void run("Request denied", async (signal) => { await client.control(chatId, item.id, "revoke", item.generation, signal); })}>Deny request</button>
            </aside>
          ))}
          {!!status?.sessions.length && (
            <label>
              Session{" "}
              <select
                disabled={busy}
                value={session?.id ?? ""}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setObservation(null);
                  setText("");
                }}
              >
                {status.sessions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.kind}: {item.targetLabel ?? item.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          {session && (
            <>
              <p>
                Target:{" "}
                <strong>{session.targetLabel ?? (session.kind === "native" ? "Native desktop on service host" : "Managed browser on service host")}</strong> ·
                State: {session.state} · Controller: {session.controller ?? "none"} · Generation: {session.generation}
              </p>
              {session.reason && <p role="status">{session.reason}</p>}
              <div className="computer-use-controls">
                {pending(session) && status?.permission !== "deny" && (
                  <button disabled={busy || denied} onClick={() => control("approve")}>
                    Approve this request
                  </button>
                )}
                <button
                  disabled={busy || denied || !active}
                  onClick={() => void run("Screenshot refreshed", (signal) => client.observe(chatId, session.id, signal))}
                >
                  Refresh screenshot
                </button>
                <button disabled={busy || denied || !active || human} onClick={() => control("takeover")}>
                  Take over
                </button>
                <button disabled={busy || denied || !human} onClick={() => control("resume")}>
                  Resume agent
                </button>
                <button disabled={terminal(session)} onClick={() => control("stop")}>
                  Stop
                </button>
                <button disabled={session.state === "revoked"} onClick={() => control("revoke")}>
                  Revoke
                </button>
                <label><input type="checkbox" checked={preview} disabled={denied || !active} onChange={(event) => setPreview(event.target.checked)} /> Live preview (1 fps)</label>
                <button onClick={hideScreenshot}>Hide screenshot</button>
              </div>
              {!frame && <p>No current screenshot. Refresh explicitly after enable, approval, takeover or a state change.</p>}
              {frame && (
                <div className="computer-use-frame">
                  <img
                    src={`data:${frame.mimeType};base64,${frame.data}`}
                    alt={`Current ${session.kind} screenshot`}
                    draggable={false}
                    style={{ cursor: canAct ? "crosshair" : "default", touchAction: canAct ? "none" : "auto" }}
                    onContextMenu={(event) => event.preventDefault()}
                    onPointerDown={(event) => {
                      if (!canAct) return;
                      dragStart.current = framePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), frame.width, frame.height);
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                    }}
                    onPointerCancel={() => {
                      dragStart.current = null;
                    }}
                    onPointerUp={(event) => {
                      if (!canAct || !dragStart.current) return;
                      const point = framePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), frame.width, frame.height);
                      const start = dragStart.current;
                      dragStart.current = null;
                      action(
                        pointerMode === "drag"
                          ? { type: "drag", fromX: start.x, fromY: start.y, toX: point.x, toY: point.y }
                          : pointerMode === "move"
                            ? { type: "move", ...point }
                            : { type: "click", ...point, button: pointerMode === "right" ? "right" : "left" },
                      );
                    }}
                  />
                  <small>
                    Screenshot pixels: {frame.width} × {frame.height}. Input uses these coordinates, not CSS pixels. Refresh if the target changed.
                  </small>
                </div>
              )}
              <fieldset disabled={!canAct}>
                <legend>Manual input — requires human takeover and a fresh screenshot</legend>
                <label>
                  Pointer{" "}
                  <select value={pointerMode} onChange={(event) => setPointerMode(event.target.value as typeof pointerMode)}>
                    <option value="click">Left click</option>
                    <option value="right">Right click</option>
                    <option value="move">Move</option>
                    <option value="drag">Drag</option>
                  </select>
                </label>
                <button onClick={() => action({ type: "scroll", deltaX: 0, deltaY: -400 })}>Scroll up</button>
                <button onClick={() => action({ type: "scroll", deltaX: 0, deltaY: 400 })}>Scroll down</button>
                <div className="computer-use-controls">
                  {["Enter", "Tab", "Escape", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].map((key) => (
                    <button key={key} onClick={() => action({ type: "key", key })}>
                      {key}
                    </button>
                  ))}
                </div>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (text) action({ type: "type", text });
                  }}
                >
                  <label>
                    Text to type <input value={text} maxLength={10000} autoComplete="off" onChange={(event) => setText(event.target.value)} />
                  </label>
                  <button disabled={!canAct || !text}>Type text</button>
                </form>
                {session.kind === "browser" && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (url) action({ type: "navigate", url });
                    }}
                  >
                    <label>
                      Browser URL <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} />
                    </label>
                    <button disabled={!canAct || !url}>Navigate</button>
                  </form>
                )}
              </fieldset>
            </>
          )}
          {busy && <p role="status">Waiting for server…</p>}
          {!!timeline.length && (
            <details>
              <summary>Viewer actions (this tab)</summary>
              <ol>
                {timeline.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
