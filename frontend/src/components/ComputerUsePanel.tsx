import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Monitor } from "lucide-react";
import type { ComputerUseCapability, ComputerUseAction, ComputerUseKind, ComputerUseObservation, ComputerUseSession } from "shared/types/computerUse.js";
import type { PermissionLevel } from "shared/types/permissions.js";
import { computerUseClient as client, controlErrorCode } from "../api/computerUse";
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

/** Keep the old pixels until the replacement is loaded and decoded, not merely
 * until the observe HTTP request finishes. No screenshot leaves this tab. */
async function readyFrame(frame: ComputerUseObservation["frame"]) {
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Screenshot image failed to load."));
  });
  image.src = `data:${frame.mimeType};base64,${frame.data}`;
  try {
    await loaded;
    if (image.decode) await image.decode();
  } finally {
    image.onload = null;
    image.onerror = null;
  }
}

const terminal = (session: ComputerUseSession) => ["stopped", "revoked", "closed", "failed", "expired"].includes(session.state);
const pending = (session: ComputerUseSession) => ["pending", "awaiting_approval", "approval_required", "pending_approval"].includes(session.state);

/** Classification is optional: never guess a diagnosis from a driver's prose. */
function DesktopReadinessNotice({ capability }: { capability?: ComputerUseCapability }) {
  const headingId = useId();
  let heading = "Desktop readiness unconfirmed";
  let guidance =
    "Retry status to check the Callboard service host. If readiness remains unavailable, ask your agent in chat to diagnose it. Only you can enable control afterward.";
  switch (capability?.readiness) {
    case "setup-required":
      heading = "Desktop setup required";
      guidance =
        "The desktop on this Callboard service host is not ready. Ask your agent in chat to check the display and desktop helpers and help configure or reconnect it. You'll still need to enable control afterward.";
      break;
    case "unsupported":
      heading = "Desktop environment unsupported";
      guidance =
        "This Callboard service host needs a compatible native driver or supported environment. Ask your agent in chat to explain the options; setup alone may not make this environment supported.";
      break;
    case "permission-blocked":
      heading = "Desktop permissions required";
      guidance =
        "Check this chat's permissions. Native desktop control on the Callboard service host requires file, network, and code permissions to be Allow because it cannot confine applications. Review that broader access before changing permissions; nothing is changed automatically.";
      break;
  }
  return (
    <div className="computer-use-notice computer-use-readiness" role="status" aria-labelledby={headingId}>
      <h3 id={headingId}>{heading}</h3>
      <p>{guidance}</p>
      {capability?.reason && (
        <details>
          <summary>Technical details</summary>
          <p>{capability.reason}</p>
        </details>
      )}
    </div>
  );
}

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
  provider,
}: {
  chatId: string;
  permission?: PermissionLevel;
  onPermissions?: () => void;
  controller: ComputerUseController;
  /** The chat's harness, when known. Only used for harness-specific grant notes. */
  provider?: string;
}) {
  const resumePrivacyId = useId();
  const sharedGrantId = useId();
  // Claude Code (Task subagents, same CLI process and tool server) and Codex
  // (native subagents on the parent's per-turn socket) run subagents inside the
  // parent's turn; the host authorizes them under the parent chat, so the grant
  // a human approves here is theirs too.
  const sharedGrantNote = provider === "codex" || provider === "claude-code" ? sharedGrantId : undefined;
  const [preview, setPreview] = useState(false);
  const { readStatus, beginMutation, status } = controller;
  const [kind, setKind] = useState<ComputerUseKind>("browser");
  const [selected, setSelected] = useState("");
  const [observation, setObservation] = useState<
    (ComputerUseObservation & { sessionId: string; controller: ComputerUseSession["controller"]; kind: ComputerUseKind; targetLabel?: string }) | null
  >(null);
  // Retained pixels are not authority: even pausing a pending preview must
  // leave the old token fenced until another fresh frame is ready.
  const [fresh, setFresh] = useState(false);
  // Explicit captures also wait for decode. A status invalidation must reject
  // their late completion even if the session later returns to the same values.
  const presentationEpoch = useRef(0);
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
  // Status lists terminal sessions too, oldest first, so a fresh mount must not
  // land on a stopped session with every control disabled while a live one exists.
  const session = status?.sessions.find((item) => item.id === selected) ?? status?.sessions.find((item) => !terminal(item)) ?? status?.sessions[0];
  const capability = status?.capabilities.find((item) => item.kind === kind);
  const denied = permission === "deny" || status?.permission === "deny";
  // What the Enable click actually consents to. Since the level began governing
  // per-action prompts, this button IS the consent boundary for unattended
  // control — and a chat someone else configured, or you configured a month
  // ago, looks identical either way. The server's level wins over the prop: the
  // prop is this tab's copy of the chat record, and a change made elsewhere
  // reaches the panel through status first.
  const level = status?.permission ?? permission;
  const active =
    session && ["active", "ready", "running"].includes(session.state) && status?.capabilities.some((item) => item.kind === session.kind && item.available);
  const frame =
    !denied &&
    active &&
    observation?.sessionId === session.id &&
    observation.generation === session.generation &&
    observation.controller === session.controller &&
    observation.kind === session.kind &&
    observation.targetLabel === session.targetLabel
      ? observation.frame
      : null;
  const human = !!active && session.controller === "human";
  const canAct = human && !!frame && fresh && !busy && !capturing && !denied;

  // Serialize normal operations; emergency stop/revoke can supersede any in-flight
  // request. The server remains responsible for cancelling already accepted work.
  const run = useCallback(
    async (label: string, work: (signal: AbortSignal) => Promise<ComputerUseObservation | void>, keepFrame = false) => {
      const ticket = ++sequence.current;
      const epoch = presentationEpoch.current;
      operationActive.current = true;
      setPreview(false);
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setBusy(true);
      setError("");
      if (!keepFrame) {
        setObservation(null);
        setFresh(false);
      }
      try {
        if (session && label !== "stop" && label !== "revoke") {
          await captures.get(captureKey(chatId, session.id))?.catch(() => {});
          if (ticket !== sequence.current || controller.signal.aborted) return;
        }
        const nextFrame = await work(controller.signal);
        await readStatus(controller.signal);
        if (ticket !== sequence.current) return;
        if (nextFrame && session) {
          await readyFrame(nextFrame.frame);
          if (ticket !== sequence.current || epoch !== presentationEpoch.current) return;
          setObservation({ ...nextFrame, sessionId: session.id, controller: session.controller, kind: session.kind, targetLabel: session.targetLabel });
          setFresh(true);
        }
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
  const sessionKind = session?.kind;
  const sessionTarget = session?.targetLabel;
  useEffect(() => {
    ++presentationEpoch.current;
    setFresh(false);
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
      previous.controller === sessionController &&
      previous.kind === sessionKind &&
      previous.targetLabel === sessionTarget
        ? previous
        : null,
    );
    dragStart.current = null;
  }, [denied, active, sessionId, sessionGeneration, sessionController, sessionKind, sessionTarget]);

  // Preview requests are not aborted on cleanup: aborting fetch cannot cancel an
  // already accepted server observation. Discard late presentation, but retain
  // its settlement barrier before any later explicit capture/control operation.
  useEffect(() => {
    if (!preview || denied || !active || !sessionId || !sessionKind || busy) return;
    let alive = true;
    let inFlight = false;
    const capture = async () => {
      if (inFlight || operationActive.current) return;
      inFlight = true;
      const ticket = sequence.current;
      setCapturing(true);
      setFresh(false);
      dragStart.current = null;
      try {
        const result = await captureFrame(chatId, sessionId, () => alive && ticket === sequence.current && !operationActive.current);
        if (!alive || ticket !== sequence.current) return;
        await readyFrame(result.frame);
        if (alive && ticket === sequence.current) {
          setObservation({ ...result, sessionId, controller: sessionController ?? null, kind: sessionKind, targetLabel: sessionTarget });
          setFresh(true);
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
  }, [preview, denied, active, sessionId, sessionGeneration, sessionController, sessionKind, sessionTarget, busy, chatId]);

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
      try {
        // An approval creates a session the shared ledger must learn even if this
        // view closes first; a fetch abort could not cancel the accepted approval.
        const result = await client.control(chatId, session.id, operation, session.generation, operation === "approve" ? undefined : signal);
        acceptResponse(result, !signal.aborted);
      } catch (error) {
        // Stopping a session the server no longer knows is settled, not failed:
        // record it as closed so the shared emergency ledger stops retrying it.
        if ((operation === "stop" || operation === "revoke") && controlErrorCode(error) === "not_found") {
          acceptResponse({ id: session.id, state: "closed" }, !signal.aborted);
          return;
        }
        throw error;
      }
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
        <div className="computer-use-setup">
          <div className="computer-use-toolbar">
            <label className="computer-use-target">
              Target{" "}
              <select value={kind} onChange={(event) => setKind(event.target.value as ComputerUseKind)}>
                <option value="browser">Managed browser</option>
                <option value="native">Native desktop (service host)</option>
              </select>
            </label>
            <button
              className="computer-use-primary"
              disabled={busy || denied || capability?.available !== true}
              aria-describedby={sharedGrantNote}
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
            {/* Beside the button, and the only always-visible statement of the
                level: the general Allow/Ask explanation moved into the
                disclosure below, so what stays on screen is which one *this*
                chat is — at the moment you consent to it. */}
            {!denied && (
              <span className="computer-use-consent" role="note" aria-label="What Enable grants">
                {level === "allow" ? (
                  <>
                    <strong>This chat is set to Allow:</strong> once you enable a target, the agent acts on it without asking you again. Each action is recorded
                    in the server log.
                  </>
                ) : (
                  <>
                    <strong>This chat is set to Ask:</strong> the agent&apos;s turn stops and asks you here in the chat before every action on the target.
                  </>
                )}
              </span>
            )}
            <div className="computer-use-toolbar-aux">
              <button className="computer-use-quiet" disabled={busy} onClick={() => void run("Status refreshed", async () => {}, true)}>
                Retry status
              </button>
              {onPermissions && (
                <button className="computer-use-link" onClick={onPermissions}>
                  Chat permissions
                </button>
              )}
            </div>
          </div>
          {/* What a viewer would otherwise assume wrongly: who can enable, whose
              machine this is, and what the model can be relied on to see. Each
              one limits a claim, so each stays on screen; the rest of the
              explanation is read once and lives in the disclosure. */}
          <p className="computer-use-brief">
            Only you can enable a target — the agent never can, at any permission level. Tools run on the configured service target, not on this viewer&apos;s
            computer. Model visual capability is not established by this viewer.
          </p>
          <details className="computer-use-about">
            <summary>How browser &amp; computer control works</summary>
            <p>
              Controls Callboard&apos;s browser and desktop tools. Enabling a target is always your own action; after that, Allow lets the agent act on its own,
              while Ask stops its turn and asks you in the chat before each action. Agents with unrestricted code execution may still run their own automation.
            </p>
          </details>
          {/* Demoted, but never hidden behind the disclosure: a description a
              button points at has to stay in the accessibility tree, and the
              native note only appears when native is the target in play. */}
          {sharedGrantNote && (
            <p className="computer-use-note" id={sharedGrantNote} role="note">
              <strong>Shared with subagents:</strong> a grant you enable or approve here is shared with any subagents the agent runs inside this chat&apos;s
              turn ({provider === "codex" ? "Codex native subagents" : "Claude Code Task subagents"}), and their screenshots and actions are recorded under this
              chat&apos;s identity.
            </p>
          )}
          {(kind === "native" || session?.kind === "native") && (
            <p className="computer-use-note" role="note">
              <strong>Same-machine native control:</strong> this targets the Callboard service host&apos;s existing desktop and applications. It requires a
              configured display and OS capture/input consent. A remote viewer does not grant control of its own desktop. Stopping control does not close your
              applications.
            </p>
          )}
          {denied && (
            <p className="computer-use-notice" role="status">
              Computer control is denied. Set Browser &amp; Computer Control to Ask or Allow in chat permissions, then retry status. Ask confirms each agent
              action with you in the chat; Allow lets the agent act unattended. Either way, only your Enable click starts a target.
            </p>
          )}
          {kind === "native" && !denied && !capability?.available && <DesktopReadinessNotice capability={capability} />}
          {kind !== "native" && !capability?.available && (
            <p className="computer-use-notice" role="status">
              {capability?.reason ??
                "Target readiness has not been confirmed. Retry status; configure the browser runtime or a supported native display on the service host."}
            </p>
          )}
          {(error || controller?.statusError) && <p role="alert">{error || controller?.statusError}</p>}
          {/* Target requests only — your own Enable click under Ask. A GUI action
              the agent wants to take is confirmed in the chat (under Ask, where
              the agent is blocked waiting for it) or not at all (under Allow);
              the server does not park those here. */}
          {status?.sessions
            .filter((item) => pending(item) && item.id !== session?.id)
            .map((item) => (
              <aside className="computer-use-request" key={item.id} aria-label="Pending target approval">
                <p>{item.reason ?? `Approve access to ${item.targetLabel ?? item.kind}`}</p>
                <div className="computer-use-controls">
                  <button
                    className="computer-use-primary"
                    disabled={busy || denied}
                    aria-describedby={sharedGrantNote}
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
                </div>
              </aside>
            ))}
        </div>
        <div className="computer-use-stage">
          {!!status?.sessions.length && (
            <label className="computer-use-session-select">
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
              <p className="computer-use-session-meta">
                Target:{" "}
                <strong>{session.targetLabel ?? (session.kind === "native" ? "Native desktop on service host" : "Managed browser on service host")}</strong> ·
                State: {session.state} · Controller: {session.controller ?? "none"} · Generation: {session.generation}
              </p>
              {session.reason && (
                <p className="computer-use-notice" role="status">
                  {session.reason}
                </p>
              )}
              <div className="computer-use-controls">
                {pending(session) && status?.permission !== "deny" && (
                  <button className="computer-use-primary" disabled={busy || denied} aria-describedby={sharedGrantNote} onClick={() => control("approve")}>
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
                <label>
                  <input type="checkbox" checked={preview} disabled={denied || !active} onChange={(event) => setPreview(event.target.checked)} /> Live preview
                  (1 fps)
                </label>
                <button onClick={hideScreenshot}>Hide screenshot</button>
                <span className="computer-use-controls-end">
                  <button className="computer-use-danger" disabled={terminal(session)} onClick={() => control("stop")}>
                    Stop
                  </button>
                  <button className="computer-use-danger" disabled={session.state === "revoked"} onClick={() => control("revoke")}>
                    Revoke
                  </button>
                </span>
              </div>
              {human && (
                <p className="computer-use-note" id={resumePrivacyId} role="note">
                  Resuming immediately captures a new agent-visible screenshot of{" "}
                  {session.kind === "native" ? "the full native desktop on the service host" : "the managed browser page"}. Remove sensitive windows or content
                  from that target first. Previewing during takeover does not itself send those images to the agent.
                </p>
              )}
              {!frame && (
                <div className="computer-use-empty">
                  <Monitor size={20} aria-hidden="true" />
                  <p>No current screenshot. Refresh explicitly after enable, approval, takeover or a state change.</p>
                </div>
              )}
              {frame && (
                <div className="computer-use-frame">
                  <div className="computer-use-viewport">
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
                  </div>
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
          {!session && (
            <div className="computer-use-empty">
              <Monitor size={20} aria-hidden="true" />
              {/* Denied already has its own notice above; repeating why here
                  is the duplication this layout exists to remove. */}
              <p>
                No target is enabled in this chat.
                {!denied && (kind !== "native" || capability?.available) && " Choose a target above and enable it; the screenshot appears here."}
              </p>
            </div>
          )}
        </div>
        <div className="computer-use-footer">
          {preview && (
            <p className="computer-use-notice computer-use-capture-status" role="status" data-capturing={capturing} aria-hidden={!capturing}>
              Capturing screenshot… Manual input is paused until a fresh frame is available.
            </p>
          )}
          {busy && (
            <p className="computer-use-notice" role="status">
              Waiting for server…
            </p>
          )}
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
      </div>
    </section>
  );
}
