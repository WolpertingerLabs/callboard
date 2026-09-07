import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ComputerUseAction, ComputerUseKind, ComputerUseObservation, ComputerUseSession } from "shared/types/computerUse.js";
import type { PermissionLevel } from "shared/types/permissions.js";
import { computerUseClient as client } from "../api/computerUse";
import "./ComputerUsePanel.css";
import type { ComputerUseController } from "../hooks/useComputerUseController";

// A fetch abort is not server-side capture cancellation. Keep accepted captures
// ordered across effect cleanup and panel remounts, and never reuse their old frame.
const captures = new Map<string, Promise<ComputerUseObservation>>();
const captureKey = (chatId: string, sessionId: string) => JSON.stringify([chatId, sessionId]);
function captureFrame(chatId: string, sessionId: string, canStart: () => boolean): Promise<ComputerUseObservation> {
  const key = captureKey(chatId, sessionId);
  const previous = captures.get(key);
  const pending = (async () => {
    await previous?.catch(() => {});
    if (!canStart()) throw new Error("Capture superseded before dispatch");
    return client.observe(chatId, sessionId, new AbortController().signal);
  })();
  captures.set(key, pending);
  void pending
    .finally(() => {
      if (captures.get(key) === pending) captures.delete(key);
    })
    .catch(() => {});
  return pending;
}

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
 * Status is read and published only through the chat's shared controller, so the
 * header strip and this view never disagree.
 */
export default function ComputerUsePanel({
  chatId,
  permission = "deny",
  onPermissions,
  controller,
}: {
  chatId: string;
  permission?: PermissionLevel;
  onPermissions?: () => void;
  controller: ComputerUseController;
}) {
  const resumePrivacyId = useId();
  const [preview, setPreview] = useState(false);
  const { readStatus, beginMutation, status } = controller;
  const [kind, setKind] = useState<ComputerUseKind>("browser");
  const [selected, setSelected] = useState("");
  const [observation, setObservation] = useState<(ComputerUseObservation & { sessionId: string; controller: ComputerUseSession["controller"] }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const operationActive = useRef(false);
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
  const canAct = human && !!frame && !busy && !capturing && !denied;

  // Serialize normal operations; emergency stop/revoke can supersede any in-flight
  // request. The server remains responsible for cancelling already accepted work.
  const run = useCallback(
    async (label: string, work: (signal: AbortSignal) => Promise<ComputerUseObservation | void>, keepFrame = false) => {
      const ticket = ++sequence.current;
      operationActive.current = true;
      setPreview(false);
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setBusy(true);
      setError("");
      if (!keepFrame) setObservation(null);
      try {
        if (session && label !== "stop" && label !== "revoke") {
          await captures.get(captureKey(chatId, session.id))?.catch(() => {});
          if (ticket !== sequence.current || controller.signal.aborted) return;
        }
        const nextFrame = await work(controller.signal);
        await readStatus(controller.signal);
        if (ticket !== sequence.current) return;
        if (nextFrame && session) setObservation({ ...nextFrame, sessionId: session.id, controller: session.controller });
        setTimeline((items) => [`${new Date().toLocaleTimeString()} — ${label}`, ...items].slice(0, 20));
      } catch (err) {
        if (ticket !== sequence.current) return;
        setObservation(null);
        // A stale frame or transport error is not a permission change. Recover
        // authority only from fresh server status, never from an invented deny;
        // the controller owns the unavailable state when that read fails too.
        await readStatus(controller.signal).catch(() => {});
        if (ticket !== sequence.current) return;
        setError(err instanceof Error ? err.message : "Computer control failed. Retry status or check server configuration.");
      } finally {
        if (ticket === sequence.current) {
          operationActive.current = false;
          setBusy(false);
        }
      }
    },
    [readStatus, session, chatId],
  );

  useEffect(() => {
    operationActive.current = false;
    setCapturing(false);
    setBusy(false);
    setPreview(false);
    dragStart.current = null;
    setObservation(null);
    setError("");
    setText("");
    setUrl("");
    return () => {
      ++sequence.current;
      abort.current?.abort();
    };
  }, [chatId, permission]);

  // Invalidate the displayed frame and any pointer press in progress only when
  // the session's identity, generation, controller or permission really changes.
  // Every 3 s status publish yields a new `session` object even when nothing
  // changed; keying on it would silently drop a click or drag that straddles a poll.
  const sessionId = session?.id;
  const sessionGeneration = session?.generation;
  const sessionController = session?.controller;
  useEffect(() => {
    if (denied || !active) {
      setPreview(false);
      setText("");
      setUrl("");
    }
    setObservation((previous) =>
      previous &&
      !denied &&
      active &&
      sessionId !== undefined &&
      previous.sessionId === sessionId &&
      previous.generation === sessionGeneration &&
      previous.controller === sessionController
        ? previous
        : null,
    );
    dragStart.current = null;
  }, [denied, active, sessionId, sessionGeneration, sessionController]);

  // Preview requests are not aborted on cleanup: aborting fetch cannot cancel an
  // already accepted server observation. Discard late presentation, but retain
  // its settlement barrier before any later explicit capture/control operation.
  useEffect(() => {
    if (!preview || denied || !active || !sessionId || busy) return;
    let alive = true;
    let inFlight = false;
    const capture = async () => {
      if (inFlight || operationActive.current) return;
      inFlight = true;
      const ticket = sequence.current;
      setCapturing(true);
      setObservation(null);
      dragStart.current = null;
      try {
        const result = await captureFrame(chatId, sessionId, () => alive && ticket === sequence.current && !operationActive.current);
        if (alive && ticket === sequence.current) {
          setObservation({ ...result, sessionId, controller: sessionController ?? null });
        }
      } catch {
        if (alive && ticket === sequence.current) {
          setObservation(null);
          setPreview(false);
          setError("Preview capture failed. Refresh a new screenshot before acting.");
        }
      } finally {
        inFlight = false;
        if (alive) setCapturing(false);
      }
    };
    const timer = window.setInterval(() => {
      void capture();
    }, 1000);
    void capture();
    return () => {
      alive = false;
      setCapturing(false);
      window.clearInterval(timer);
    };
  }, [preview, denied, active, sessionId, sessionGeneration, sessionController, busy, chatId]);

  const hideScreenshot = () => {
    setPreview(false);
    ++sequence.current;
    abort.current?.abort();
    operationActive.current = false;
    setBusy(false);
    setObservation(null);
    setText("");
    dragStart.current = null;
  };

  const control = (operation: "takeover" | "resume" | "stop" | "revoke" | "approve") => {
    if (!session) return;
    void run(operation, async (signal) => {
      const acceptResponse = beginMutation(operation === "approve" ? session : undefined);
      // An approval creates a session the shared ledger must learn even if this
      // view closes first; a fetch abort could not cancel the accepted approval.
      const result = await client.control(chatId, session.id, operation, session.generation, operation === "approve" ? undefined : signal);
      acceptResponse(result, !signal.aborted);
    });
  };
  const action = (value: ComputerUseAction) => {
    if (!canAct || !session || !frame || operationActive.current || captures.has(captureKey(chatId, session.id))) return;
    setText("");
    void run(`Manual ${value.type}`, async (signal) => {
      const acceptResponse = beginMutation();
      const result = await client.action(
        chatId,
        session.id,
        {
          action: value,
          expectedGeneration: session.generation,
          frameId: observation!.frameId,
          requestId: crypto.randomUUID(),
        },
        signal,
      );
      acceptResponse(result, !signal.aborted);
      return captureFrame(chatId, session.id, () => !signal.aborted);
    });
  };

  return (
    <section className="computer-use-panel" aria-label="Browser & Computer Control">
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
                const acceptResponse = beginMutation();
                // Keep stop-only knowledge even after this viewer closes. A
                // fetch abort cannot cancel a server-accepted open.
                const opened = await client.open(chatId, kind);
                acceptResponse(opened.session, !signal.aborted);
                if (!signal.aborted) {
                  setSelected(opened.session.id);
                }
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
        {denied && <p role="status">Computer control is denied. Set Browser &amp; Computer Control to Ask or Allow in chat permissions, then retry status.</p>}
        {!capability?.available && (
          <p role="status">
            {capability?.reason ??
              "Target readiness has not been confirmed. Retry status; configure the browser runtime or a supported native display on the service host."}
          </p>
        )}
        {(error || controller?.statusError) && <p role="alert">{error || controller?.statusError}</p>}
        {status?.sessions
          .filter((item) => pending(item) && item.id !== session?.id)
          .map((item) => (
            <aside key={item.id} aria-label="Pending computer approval">
              <p>{item.reason ?? `Approve access to ${item.targetLabel ?? item.kind}`}</p>
              <button
                disabled={busy || denied}
                onClick={() =>
                  void run("Request approved", async (signal) => {
                    const acceptResponse = beginMutation(item);
                    const result = await client.control(chatId, item.id, "approve", item.generation);
                    acceptResponse(result, !signal.aborted);
                  })
                }
              >
                Confirm request
              </button>
              <button
                onClick={() =>
                  void run("Request denied", async (signal) => {
                    const acceptResponse = beginMutation();
                    const result = await client.control(chatId, item.id, "revoke", item.generation, signal);
                    acceptResponse(result, !signal.aborted);
                  })
                }
              >
                Deny request
              </button>
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
                onClick={() => void run("Screenshot refreshed", (signal) => captureFrame(chatId, session.id, () => !signal.aborted))}
              >
                Refresh screenshot
              </button>
              <button disabled={busy || denied || !active || human} onClick={() => control("takeover")}>
                Take over
              </button>
              <button disabled={busy || denied || !human} aria-describedby={human ? resumePrivacyId : undefined} onClick={() => control("resume")}>
                Resume agent
              </button>
              {human && (
                <p id={resumePrivacyId} role="note">
                  Resuming immediately captures a new agent-visible screenshot of{" "}
                  {session.kind === "native" ? "the full native desktop on the service host" : "the managed browser page"}. Remove sensitive windows or content
                  from that target first. Previewing during takeover does not itself send those images to the agent.
                </p>
              )}
              <button disabled={terminal(session)} onClick={() => control("stop")}>
                Stop
              </button>
              <button disabled={session.state === "revoked"} onClick={() => control("revoke")}>
                Revoke
              </button>
              <label>
                <input type="checkbox" checked={preview} disabled={denied || !active} onChange={(event) => setPreview(event.target.checked)} /> Live preview (1
                fps)
              </label>
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
                  Text to type <input value={text} maxLength={4096} autoComplete="off" onChange={(event) => setText(event.target.value)} />
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
        {capturing && <p role="status">Capturing screenshot… Manual input is paused until a fresh frame is available.</p>}
        {busy && <p role="status">Waiting for server…</p>}
        {!!status?.events?.length && (
          <details>
            <summary>Service events (memory only)</summary>
            <ol>
              {status.events.map((event, index) => (
                <li key={index}>
                  {new Date(event.at).toLocaleTimeString()} · {event.type} · {event.sessionId} · generation {event.generation}
                </li>
              ))}
            </ol>
          </details>
        )}
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
    </section>
  );
}
