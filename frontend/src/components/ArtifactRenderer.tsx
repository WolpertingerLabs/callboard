import { useState, useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { Maximize2 } from "lucide-react";
import ModalOverlay from "./ModalOverlay";
import MarkdownRenderer from "./MarkdownRenderer";
import { useFrameSizing } from "./useFrameSizing";
import { createArtifactBridge, type ArtifactBridge, type BridgeStorageApi } from "./artifactBridge";
import { artifactRenderUrl, getArtifactVersionSource } from "../api";
import type { RenderArtifactData, StorageAccess } from "../types/storageArtifacts";

interface ArtifactRendererProps {
  data: RenderArtifactData;
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
  src: string;
  title: string;
  storageKey: string | null;
  access: StorageAccess;
  frameRef?: RefObject<HTMLIFrameElement>;
  style: CSSProperties;
  onLoaded: () => void;
  bridgeApi?: BridgeStorageApi;
}

/**
 * One mount of a sandboxed artifact document plus its storage bridge.
 *
 * The bridge is created once per mount, so every mount gets a fresh nonce, and
 * the parent keys this component on (src, key, access) — changing any of them
 * is a new mount, never a re-grant to a document that is already running.
 *
 * `sandbox="allow-scripts"` and nothing else: no same-origin (so no cookies and
 * no /api), no top navigation, no popups, no forms.
 */
function ArtifactFrame({ src, title, storageKey, access, frameRef, style, onLoaded, bridgeApi }: ArtifactFrameProps) {
  const ownRef = useRef<HTMLIFrameElement>(null);
  const ref = frameRef ?? ownRef;
  const [bridge] = useState<ArtifactBridge>(() =>
    createArtifactBridge({ getFrameWindow: () => ref.current?.contentWindow, storageKey, access, api: bridgeApi }),
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent) => void bridge.handleMessage(e);
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [bridge]);

  return (
    <iframe
      ref={ref}
      src={src}
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

/**
 * Renders a `render_artifact` result — in chat, and as the live preview in
 * Settings → Artifacts. HTML runs in the sandboxed frame with the storage
 * bridge; SVG goes through `<img>` (scripts inert); markdown is fetched as text
 * and rendered by MarkdownRenderer, never executed.
 */
export default function ArtifactRenderer({ data, maxWidth = "85%", bridgeApi }: ArtifactRendererProps) {
  const [expanded, setExpanded] = useState(data.display_mode === "fullscreen");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const src = artifactRenderUrl(data.artifact_id, data.version);
  const storageKey = data.storage_key ?? null;
  const access: StorageAccess = storageKey ? data.storage_access : "none";
  const frameKey = `${src}|${storageKey ?? ""}|${access}`;
  const isHtml = data.content_type === "html";

  const { contentHeight, contentWidth, needsScale, scale, displayHeight } = useFrameSizing(iframeRef, containerRef, isHtml);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  useEffect(() => {
    if (data.content_type !== "markdown") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getArtifactVersionSource(data.artifact_id, data.version)
      .then((text) => !cancelled && setMarkdown(text))
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [data.content_type, data.artifact_id, data.version]);

  // A new document is loading whenever the frame identity changes.
  useEffect(() => {
    if (data.content_type !== "markdown") setLoading(true);
  }, [frameKey, data.content_type]);

  if (error) {
    return (
      <div
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
        Failed to load artifact: {data.name} (v{data.version}) — {error}
      </div>
    );
  }

  const renderContent = (isModal: boolean) => {
    switch (data.content_type) {
      case "html":
        if (isModal) {
          return (
            <ArtifactFrame
              key={`modal|${frameKey}`}
              src={src}
              title={data.name}
              storageKey={storageKey}
              access={access}
              bridgeApi={bridgeApi}
              onLoaded={() => {}}
              style={{ width: "100%", height: "85vh" }}
            />
          );
        }
        return (
          <div style={{ width: "100%", height: displayHeight, overflow: "hidden", transition: "height 0.15s ease" }}>
            <ArtifactFrame
              key={frameKey}
              frameRef={iframeRef}
              src={src}
              title={data.name}
              storageKey={storageKey}
              access={access}
              bridgeApi={bridgeApi}
              onLoaded={() => setLoading(false)}
              style={{
                width: needsScale ? contentWidth : "100%",
                height: contentHeight,
                transformOrigin: "top left",
                transform: needsScale ? `scale(${scale})` : undefined,
              }}
            />
          </div>
        );
      case "svg":
        return (
          <img
            src={src}
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
            {storageKey && (
              <span
                title={`Bound to storage key "${storageKey}" with ${access === "readwrite" ? "read/write" : access} access`}
                style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}
              >
                {storageKey} · {access === "readwrite" ? "rw" : access}
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
            {!loading && (
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

      {expanded && (
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
              <button
                onClick={() => setExpanded(false)}
                title="Close"
                style={{
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
                }}
              >
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
