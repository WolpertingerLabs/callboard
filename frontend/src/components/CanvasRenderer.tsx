import { useState, useRef } from "react";
import FullscreenFrame, { FullscreenButton } from "./FullscreenFrame";
import { useFrameSizing } from "./useFrameSizing";

export interface RenderCanvasData {
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

export default function CanvasRenderer({ data }: CanvasRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const contentUrl = `/api/canvas/${encodeURIComponent(data.canvas_id)}/${data.version}`;

  const { contentHeight, contentWidth, needsScale, scale, displayHeight } = useFrameSizing(iframeRef, containerRef, data.content_type === "html");

  const onLoad = () => setLoading(false);
  const onError = () => {
    setLoading(false);
    setError(true);
  };

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
                background: "var(--canvas-bg)",
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
                background: "var(--canvas-bg)",
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
            {!loading && <FullscreenButton onClick={() => setExpanded(true)} />}
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
        <FullscreenFrame
          onClose={() => setExpanded(false)}
          caption={data.caption}
          frameStyle={data.content_type === "html" ? { width: "90vw", height: "90vh" } : undefined}
        >
          {renderContent(true)}
        </FullscreenFrame>
      )}
    </>
  );
}
