import { useState, useEffect, useLayoutEffect, useRef, useCallback, type CSSProperties, type MutableRefObject } from "react";
import { Maximize2 } from "lucide-react";
import ModalOverlay from "./ModalOverlay";
import MarkdownRenderer from "./MarkdownRenderer";
import { useFrameSizing } from "./useFrameSizing";
import { createArtifactBridge, type ArtifactBridge, type BridgeStorageApi } from "./artifactBridge";
import { artifactRenderUrl, getArtifact, getArtifactVersionSource } from "../api";
import type { RenderArtifactToolResult, ArtifactStorageAccess } from "../api";
import { artifactLookup, judgeRender, recheckGrant, type Verdict } from "./artifactGrant";
import type { RequestBudget } from "./artifactBudget";

interface ArtifactRendererProps {
  data: RenderArtifactToolResult;
  /** Wrapper max width. Chat bubbles use the default; the Settings preview pane passes "100%". */
  maxWidth?: CSSProperties["maxWidth"];
  /** Test seam for the bridge's storage calls; production uses the REST API. */
  bridgeApi?: BridgeStorageApi;
}

/**
 * The artifact document is authored against browser defaults (black text on a
 * white page), so its backdrop is the browser's own light document canvas in
 * every theme — the same reason CanvasRenderer paints its frame white. Written
 * as the `Canvas` system colour under a forced light scheme so no literal colour
 * appears here.
 */
const DOCUMENT_BACKDROP: CSSProperties = { colorScheme: "light", background: "Canvas" };

interface ArtifactFrameProps {
  artifactId: string;
  version: number;
  /** The version sha256 the mount was judged for; the server serves only bytes that hash to it. */
  sha256: string;
  title: string;
  storageKey: string | null;
  access: ArtifactStorageAccess;
  recheck: (maxAgeMs: number, budget: RequestBudget) => Promise<ArtifactStorageAccess>;
  onAccessChange: (access: ArtifactStorageAccess) => void;
  frameRef?: MutableRefObject<HTMLIFrameElement | null>;
  style: CSSProperties;
  onLoaded: () => void;
  bridgeApi?: BridgeStorageApi;
}

/**
 * One mount of a sandboxed artifact document plus its storage bridge.
 *
 * The bridge is created once per mount, so every mount gets a fresh token —
 * which goes into this frame's src and nowhere else — and the parent keys this
 * component on (artifact, version, key, access): changing any of them is a new
 * mount, never a re-grant to a document that is already running.
 *
 * The `message` listener is a layout effect so it is in place before the
 * frame's document can run: the shim says hello while the page is still
 * parsing, possibly before the frame's `load`. Unmounting revokes the bridge
 * (closing the host's end of the port, which otherwise lingers with its
 * handler) — deferred by a tick and cancelled if the effect re-runs, because
 * StrictMode tears the effect down and re-runs it on a mount that is still
 * live. Revocation is hygiene here, not the boundary: the bridge answers only
 * down the port its hello carried, whose other end dies with the document.
 *
 * The page becoming visible again re-checks the grant (the artifact may have
 * been lowered or deleted while this tab was in the background) — through the
 * tab's shared per-artifact check, so it fetches only if no mount of this
 * artifact has checked within ARTIFACT_BRIDGE_READ_RECHECK_MS: ten bubbles and
 * a user flicking between tabs cost one request per five seconds, not ten per
 * switch.
 *
 * `sandbox="allow-scripts"` and nothing else: no same-origin (so no cookies and
 * no /api), no top navigation, no popups, no forms.
 */
function ArtifactFrame({
  artifactId,
  version,
  sha256,
  title,
  storageKey,
  access,
  recheck,
  onAccessChange,
  frameRef,
  style,
  onLoaded,
  bridgeApi,
}: ArtifactFrameProps) {
  // The element lives in a plain holder rather than a ref so the bridge can
  // close over it without reading a ref during render; it is only dereferenced
  // when a load or message arrives.
  const [bridge, holder] = useState(() => {
    const h: { el: HTMLIFrameElement | null } = { el: null };
    const b: ArtifactBridge = createArtifactBridge({
      getFrameWindow: () => h.el?.contentWindow,
      storageKey,
      access,
      api: bridgeApi,
      recheck,
      onAccessChange,
      budgetGroup: artifactId,
    });
    return [b, h] as const;
  })[0];
  const revokeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setFrame = useCallback(
    (el: HTMLIFrameElement | null) => {
      holder.el = el;
      if (frameRef) frameRef.current = el;
    },
    [holder, frameRef],
  );

  useLayoutEffect(() => {
    if (revokeTimer.current !== null) {
      clearTimeout(revokeTimer.current); // StrictMode's re-run: still the same live mount
      revokeTimer.current = null;
    }
    const onMessage = (e: MessageEvent) => bridge.handleMessage(e);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void bridge.refresh();
    };
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibility);
      revokeTimer.current = setTimeout(() => {
        revokeTimer.current = null;
        bridge.revoke();
      }, 0);
    };
  }, [bridge]);

  return (
    <iframe
      ref={setFrame}
      src={artifactRenderUrl(artifactId, version, { bridgeToken: bridge.token, sha256 })}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={() => {
        bridge.handleLoad();
        onLoaded();
      }}
      style={{ border: "none", ...DOCUMENT_BACKDROP, ...style }}
    />
  );
}

const FULLSCREEN_BACKDROP: CSSProperties = { position: "fixed", inset: 0, background: "var(--overlay-bg)", zIndex: 1000 };
const FULLSCREEN_FRAME_BOX: CSSProperties = {
  position: "fixed",
  top: "5vh",
  left: "5vw",
  width: "90vw",
  height: "90vh",
  zIndex: 1001,
  borderRadius: "var(--radius)",
  overflow: "hidden",
  boxShadow: "var(--shadow-md)",
};

/**
 * Renders a `render_artifact` result — in chat, and as the live preview in
 * Settings → Artifacts. HTML runs in the sandboxed frame with the storage
 * bridge; SVG goes through `<img>` (scripts inert); markdown is fetched as text
 * and rendered by MarkdownRenderer, never executed.
 *
 * Nothing is mounted until {@link judgeRender} has checked the result against
 * the artifact as it is now; a refusal shows the error box instead.
 *
 * Fullscreen for HTML is the SAME frame restyled to cover the viewport, never
 * a second mount: two live instances bound to one key would each hold their
 * own copy of the data and overwrite each other's writes, and remounting would
 * reload the document (and a reload revokes the bridge). SVG and markdown are
 * stateless, so they use a plain modal.
 */
export default function ArtifactRenderer({ data, maxWidth = "85%", bridgeApi }: ArtifactRendererProps) {
  const [expanded, setExpanded] = useState(data.display_mode === "fullscreen");
  const [loading, setLoading] = useState(true);
  // Keyed by the result they belong to, so switching result (another version,
  // another grant) starts clean instead of inheriting the last one's state.
  const [errorFor, setErrorFor] = useState<{ key: string; message: string } | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [judged, setJudged] = useState<{ key: string; verdict: Verdict } | null>(null);
  // A live re-check can lower a mounted frame's grant; the badge follows it (the frame does not remount).
  const [lowered, setLowered] = useState<{ frameKey: string; access: ArtifactStorageAccess } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isHtml = data.content_type === "html";
  const storageKey = data.storage_key ?? null;
  const renderKey = `${data.artifact_id}|${data.version}|${data.sha256 ?? ""}|${data.content_type}|${storageKey ?? ""}|${data.storage_access}`;
  const verdict: Verdict = judged?.key === renderKey ? judged.verdict : { status: "checking" };
  const error = errorFor?.key === renderKey ? errorFor.message : null;
  const setError = (message: string) => setErrorFor({ key: renderKey, message });
  const access: ArtifactStorageAccess = verdict.status === "ok" && storageKey ? verdict.access : "none";
  const frameKey = `${renderKey}|${access}`;
  const mounted = verdict.status === "ok";
  const shownAccess: ArtifactStorageAccess = lowered?.frameKey === frameKey ? lowered.access : access;

  // Sizing follows the inline layout only: what the document reports while it
  // fills the viewport must not become its inline size when fullscreen closes.
  const { contentHeight, contentWidth, needsScale, scale, displayHeight } = useFrameSizing(iframeRef, containerRef, isHtml && mounted && !expanded);

  // Re-judge whenever the result changes; a failure to look is a refusal. The
  // fetch is always fresh (a preview just after a save must see the new
  // version) and seeds the shared re-check, so the mount starts checked.
  useEffect(() => {
    let cancelled = false;
    const key = renderKey;
    const startedAt = Date.now();
    getArtifact(data.artifact_id)
      .then((artifact) => {
        artifactLookup.seed(data.artifact_id, startedAt, artifact);
        if (!cancelled) setJudged({ key, verdict: judgeRender(data, artifact) });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        const reason = /not found/i.test(err.message) ? `"${data.artifact_id}" no longer exists.` : `could not check the artifact (${err.message}).`;
        setJudged({ key, verdict: { status: "refused", reason } });
      });
    return () => {
      cancelled = true;
    };
    // renderKey captures every field of `data` the verdict depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  const pinnedSha = verdict.status === "ok" ? verdict.sha256 : null;
  useEffect(() => {
    if (data.content_type !== "markdown" || !pinnedSha) return;
    let cancelled = false;
    setLoading(true);
    // Pinned like the frame: the server refuses bytes that are not the version this result was judged for.
    getArtifactVersionSource(data.artifact_id, data.version, pinnedSha)
      .then((text) => !cancelled && setMarkdown(text))
      .catch((err: Error) => !cancelled && setErrorFor({ key: renderKey, message: err.message }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [data.content_type, data.artifact_id, data.version, pinnedSha, renderKey]);

  // A new document is loading whenever the frame identity changes.
  useEffect(() => {
    if (data.content_type !== "markdown") setLoading(true);
  }, [frameKey, data.content_type]);

  const failure = verdict.status === "refused" ? verdict.reason : error;
  if (failure) {
    return (
      <div
        role="alert"
        style={{
          margin: "4px 0",
          maxWidth,
          padding: "12px 16px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--surface)",
          color: "var(--text-muted)",
          fontSize: 13,
        }}
      >
        Failed to load artifact: {data.name} (v{data.version}) — {failure}
      </div>
    );
  }

  const htmlFullscreen = isHtml && expanded;

  const renderContent = (isModal: boolean) => {
    switch (data.content_type) {
      case "html":
        // One frame, always at this position in the tree; fullscreen only restyles its box.
        return (
          <div style={{ width: "100%", height: displayHeight, overflow: "hidden", transition: "height 0.15s ease" }}>
            <div
              style={htmlFullscreen ? { ...FULLSCREEN_FRAME_BOX, ...DOCUMENT_BACKDROP } : { width: "100%", height: "100%" }}
              data-testid="artifact-frame-box"
            >
              {mounted && (
                <ArtifactFrame
                  key={frameKey}
                  frameRef={iframeRef}
                  artifactId={data.artifact_id}
                  version={data.version}
                  sha256={verdict.sha256}
                  title={data.name}
                  storageKey={storageKey}
                  access={access}
                  recheck={(maxAgeMs, budget) => recheckGrant(data, verdict.sha256, maxAgeMs, budget)}
                  onAccessChange={(next) => setLowered({ frameKey, access: next })}
                  bridgeApi={bridgeApi}
                  onLoaded={() => setLoading(false)}
                  style={
                    htmlFullscreen
                      ? { width: "100%", height: "100%" }
                      : {
                          width: needsScale ? contentWidth : "100%",
                          height: contentHeight,
                          transformOrigin: "top left",
                          transform: needsScale ? `scale(${scale})` : undefined,
                        }
                  }
                />
              )}
              {htmlFullscreen && (
                <button onClick={() => setExpanded(false)} title="Close" aria-label="Close" style={closeButtonStyle}>
                  &times;
                </button>
              )}
            </div>
            {htmlFullscreen && <div style={FULLSCREEN_BACKDROP} onClick={() => setExpanded(false)} data-testid="artifact-fullscreen-backdrop" />}
          </div>
        );
      case "svg":
        if (!pinnedSha) return null;
        return (
          <img
            src={artifactRenderUrl(data.artifact_id, data.version, { sha256: pinnedSha })}
            alt={data.caption || data.name}
            referrerPolicy="no-referrer"
            onLoad={() => setLoading(false)}
            onError={() => {
              setLoading(false);
              setError("image failed to load");
            }}
            style={{
              maxHeight: isModal ? "85vh" : 400,
              maxWidth: isModal ? "90vw" : "100%",
              objectFit: "contain",
              display: "block",
              ...DOCUMENT_BACKDROP,
            }}
          />
        );
      case "markdown":
        return (
          <div
            style={{
              padding: "8px 16px",
              maxHeight: isModal ? "85vh" : 600,
              overflow: "auto",
              background: "var(--surface)",
              color: "var(--text)",
            }}
          >
            {markdown !== null && <MarkdownRenderer content={markdown} />}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <>
      <div style={{ margin: "4px 0", maxWidth }} data-testid="artifact-renderer">
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--surface)", overflow: "hidden" }}>
          <div
            style={{
              padding: "8px 12px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
            }}
          >
            <span style={{ fontWeight: 600, color: "var(--text)", flex: 1, minWidth: 0 }}>{data.name}</span>
            {storageKey && shownAccess !== "none" && (
              <span
                title={`Bound to storage key "${storageKey}" with ${shownAccess === "readwrite" ? "read/write" : shownAccess} access`}
                style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}
                data-testid="artifact-key-badge"
              >
                {storageKey} · {shownAccess === "readwrite" ? "rw" : shownAccess}
              </span>
            )}
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--accent)",
                color: "var(--text-on-accent)",
                flexShrink: 0,
              }}
            >
              v{data.version}
            </span>
          </div>

          <div ref={containerRef} style={{ position: "relative" }}>
            {loading && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "var(--surface)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-muted)",
                  fontSize: 13,
                  minHeight: 100,
                }}
              >
                Loading...
              </div>
            )}
            {renderContent(false)}
            {!loading && !htmlFullscreen && (
              <button
                onClick={() => setExpanded(true)}
                title="Fullscreen"
                style={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  background: "var(--overlay-bg)",
                  border: "none",
                  borderRadius: 6,
                  width: 28,
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-on-accent)",
                  cursor: "pointer",
                  opacity: 0.7,
                }}
              >
                <Maximize2 size={14} />
              </button>
            )}
          </div>

          {data.caption && (
            <div style={{ padding: "6px 12px", borderTop: "1px solid var(--border)", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
              {data.caption}
            </div>
          )}
        </div>
      </div>

      {expanded && !isHtml && (
        <ModalOverlay onClose={() => setExpanded(false)}>
          <div
            onClick={(e) => {
              if (e.target === e.currentTarget) setExpanded(false);
            }}
            style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "relative",
                maxWidth: "90vw",
                maxHeight: "90vh",
                width: data.content_type === "svg" ? undefined : "90vw",
              }}
            >
              <button onClick={() => setExpanded(false)} title="Close" aria-label="Close" style={closeButtonStyle}>
                &times;
              </button>
              {renderContent(true)}
            </div>
          </div>
        </ModalOverlay>
      )}
    </>
  );
}

const closeButtonStyle: CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  zIndex: 1,
  background: "var(--overlay-bg)",
  border: "none",
  borderRadius: "50%",
  width: 32,
  height: 32,
  color: "var(--text-on-accent)",
  fontSize: 18,
  cursor: "pointer",
  lineHeight: 1,
};
