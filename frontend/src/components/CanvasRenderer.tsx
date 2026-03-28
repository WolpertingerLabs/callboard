import { useState, useEffect, useCallback, useRef } from "react";
import { Maximize2 } from "lucide-react";
import ModalOverlay from "./ModalOverlay";

interface RenderCanvasData {
  type: "render_canvas";
  canvas_id: string;
  version: number;
  name: string;
  content_type: "html" | "svg" | "image";
  description?: string;
  caption?: string;
}

interface CanvasRendererProps {
  data: RenderCanvasData;
}

const MIN_HEIGHT = 60;
const MAX_HEIGHT = 2000;
const DEFAULT_HEIGHT = 400;

export default function CanvasRenderer({ data }: CanvasRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Natural content dimensions reported by the iframe
  const [contentHeight, setContentHeight] = useState(DEFAULT_HEIGHT);
  const [contentWidth, setContentWidth] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const contentUrl = `/api/canvas/${encodeURIComponent(data.canvas_id)}/${data.version}`;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && expanded) {
        setExpanded(false);
      }
    },
    [expanded],
  );

  useEffect(() => {
    if (expanded) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [expanded, handleKeyDown]);

  // Listen for size reports from the injected script inside the iframe
  useEffect(() => {
    if (data.content_type !== "html") return;

    const handler = (e: MessageEvent) => {
      if (e.data?.type !== "canvas-resize" || typeof e.data.height !== "number") return;
      // Only accept messages from our iframe
      if (iframeRef.current && e.source === iframeRef.current.contentWindow) {
        const h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, e.data.height));
        setContentHeight(h);
        if (typeof e.data.width === "number" && e.data.width > 0) {
          setContentWidth(e.data.width);
        }
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [data.content_type]);

  // Track container width so we can scale oversized content
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onLoad = () => setLoading(false);
  const onError = () => {
    setLoading(false);
    setError(true);
  };

  // If the content is wider than the container, scale it down proportionally
  const needsScale = contentWidth > 0 && containerWidth > 0 && contentWidth > containerWidth;
  const scale = needsScale ? containerWidth / contentWidth : 1;
  const displayHeight = contentHeight * scale;

  if (error) {
    return (
      <div
        style={{
          margin: "4px 0",
          maxWidth: "85%",
          padding: "12px 16px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--surface)",
          color: "var(--text-muted)",
          fontSize: 13,
        }}
      >
        Failed to load canvas: {data.name} (v{data.version})
      </div>
    );
  }

  const renderContent = (isModal: boolean) => {
    const maxWidth = isModal ? "90vw" : "100%";

    switch (data.content_type) {
      case "html":
        if (isModal) {
          return (
            <iframe
              src={contentUrl}
              title={data.name}
              sandbox="allow-scripts"
              onLoad={onLoad}
              onError={onError}
              style={{
                width: "100%",
                height: "85vh",
                maxWidth,
                border: "none",
                background: "#fff",
              }}
            />
          );
        }
        // Inline: iframe is set to the content's natural dimensions,
        // then scaled down via CSS transform if wider than the container.
        // The wrapper div provides the correct layout height.
        return (
          <div
            style={{
              width: "100%",
              height: displayHeight,
              overflow: "hidden",
              borderRadius: "var(--radius)",
              transition: "height 0.15s ease",
            }}
          >
            <iframe
              ref={iframeRef}
              src={contentUrl}
              title={data.name}
              sandbox="allow-scripts"
              onLoad={onLoad}
              onError={onError}
              style={{
                width: needsScale ? contentWidth : "100%",
                height: contentHeight,
                border: "none",
                background: "#fff",
                transformOrigin: "top left",
                transform: needsScale ? `scale(${scale})` : undefined,
              }}
            />
          </div>
        );

      case "svg":
        return (
          <img
            src={contentUrl}
            alt={data.caption || data.name}
            referrerPolicy="no-referrer"
            onLoad={onLoad}
            onError={onError}
            style={{
              maxHeight: isModal ? "85vh" : 400,
              maxWidth,
              objectFit: "contain",
              display: "block",
              borderRadius: isModal ? 0 : "var(--radius)",
            }}
          />
        );

      case "image":
        return (
          <img
            src={contentUrl}
            alt={data.caption || data.name}
            referrerPolicy="no-referrer"
            onLoad={onLoad}
            onError={onError}
            style={{
              maxHeight: isModal ? "85vh" : 400,
              maxWidth,
              objectFit: "contain",
              display: "block",
              borderRadius: isModal ? 0 : "var(--radius)",
            }}
          />
        );

      default:
        return null;
    }
  };

  return (
    <>
      <div style={{ margin: "4px 0", maxWidth: "85%" }}>
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            background: "var(--surface)",
            overflow: "hidden",
          }}
        >
          {/* Header bar: name + version badge */}
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

          {/* Content area */}
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
            {/* Fullscreen button */}
            {!loading && (
              <button
                onClick={() => setExpanded(true)}
                title="Fullscreen"
                style={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  background: "rgba(0, 0, 0, 0.5)",
                  border: "none",
                  borderRadius: 6,
                  width: 28,
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                  cursor: "pointer",
                  opacity: 0.7,
                  transition: "opacity 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
              >
                <Maximize2 size={14} />
              </button>
            )}
          </div>

          {/* Footer: description + caption */}
          {(data.description || data.caption) && (
            <div
              style={{
                padding: "6px 12px",
                borderTop: "1px solid var(--border)",
                fontSize: 12,
                color: "var(--text-muted)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              {data.description && <div>{data.description}</div>}
              {data.caption && <div style={{ fontStyle: "italic" }}>{data.caption}</div>}
            </div>
          )}
        </div>
      </div>

      {/* Fullscreen modal */}
      {expanded && (
        <ModalOverlay>
          <div
            onClick={(e) => {
              if (e.target === e.currentTarget) setExpanded(false);
            }}
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "relative",
                cursor: "default",
                maxWidth: "90vw",
                maxHeight: "90vh",
                width: data.content_type === "html" ? "90vw" : undefined,
                height: data.content_type === "html" ? "90vh" : undefined,
              }}
            >
              {/* Close button */}
              <button
                onClick={() => setExpanded(false)}
                style={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  zIndex: 1,
                  background: "rgba(0, 0, 0, 0.6)",
                  border: "none",
                  borderRadius: "50%",
                  width: 32,
                  height: 32,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                  fontSize: 18,
                  cursor: "pointer",
                  lineHeight: 1,
                }}
              >
                &times;
              </button>
              {renderContent(true)}
              {data.caption && (
                <div
                  style={{
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: 13,
                    marginTop: 8,
                  }}
                >
                  {data.caption}
                </div>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}
    </>
  );
}
