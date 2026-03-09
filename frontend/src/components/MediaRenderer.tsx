import { useState, useEffect, useCallback } from "react";
import { ShieldAlert, Maximize2 } from "lucide-react";
import ModalOverlay from "./ModalOverlay";

interface RenderFileData {
  type: "render_file";
  file_path?: string;
  url?: string;
  media_type: "image" | "audio" | "video" | "pdf";
  mime_type: string;
  display_mode: "inline" | "fullscreen";
  file_size: number;
  caption?: string;
  untrusted?: boolean;
  untrusted_reason?: string;
}

interface MediaRendererProps {
  data: RenderFileData;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

function getFileNameFromUrl(url: string): string {
  try {
    return new URL(url).pathname.split("/").pop() || url;
  } catch {
    return url;
  }
}

export default function MediaRenderer({ data }: MediaRendererProps) {
  const [expanded, setExpanded] = useState(data.display_mode === "fullscreen");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [trustDismissed, setTrustDismissed] = useState(false);

  const contentUrl = data.url || `/api/files/serve?path=${encodeURIComponent(data.file_path!)}`;
  const fileName = data.url ? getFileNameFromUrl(data.url) : getFileName(data.file_path!);

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

  const onLoad = () => setLoading(false);
  const onError = () => {
    setLoading(false);
    setError(true);
  };

  // Untrusted content gate
  if (data.untrusted && !trustDismissed) {
    return (
      <div style={{ margin: "4px 0", maxWidth: "85%" }}>
        <div
          style={{
            border: "1px solid var(--danger-border)",
            borderRadius: "var(--radius)",
            background: "var(--warning-bg)",
            padding: "16px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ShieldAlert size={18} style={{ color: "var(--warning)", flexShrink: 0 }} />
            <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>Untrusted content</span>
          </div>

          <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {data.untrusted_reason || "This content has been flagged as potentially unsafe."}
          </div>

          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div>
              <span style={{ fontWeight: 500 }}>Source: </span>
              <span style={{ wordBreak: "break-all" }}>{data.url || data.file_path}</span>
            </div>
            <div>
              <span style={{ fontWeight: 500 }}>Type: </span>
              {data.media_type} ({data.mime_type})
            </div>
          </div>

          <button
            onClick={() => setTrustDismissed(true)}
            style={{
              alignSelf: "flex-start",
              padding: "6px 14px",
              fontSize: 13,
              fontWeight: 500,
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            View anyway
          </button>
        </div>
      </div>
    );
  }

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
        Failed to load {data.media_type}: {fileName}
      </div>
    );
  }

  const renderMedia = (isModal: boolean) => {
    const maxHeight = isModal ? "85vh" : 400;
    const maxWidth = isModal ? "90vw" : "100%";

    switch (data.media_type) {
      case "image":
        return (
          <img
            src={contentUrl}
            alt={data.caption || fileName}
            referrerPolicy="no-referrer"
            onLoad={onLoad}
            onError={onError}
            style={{
              maxHeight,
              maxWidth,
              objectFit: "contain",
              display: "block",
              borderRadius: isModal ? 0 : "var(--radius)",
            }}
          />
        );

      case "audio":
        return (
          <audio
            controls
            preload="metadata"
            {...({ referrerPolicy: "no-referrer" } as any)}
            onLoadedMetadata={onLoad}
            onError={onError}
            style={{ width: "100%", maxWidth: isModal ? "600px" : "100%" }}
          >
            <source src={contentUrl} type={data.mime_type} />
          </audio>
        );

      case "video":
        return (
          <video
            controls
            preload="metadata"
            {...({ referrerPolicy: "no-referrer" } as any)}
            onLoadedMetadata={onLoad}
            onError={onError}
            style={{
              maxHeight,
              maxWidth,
              display: "block",
              borderRadius: isModal ? 0 : "var(--radius)",
            }}
          >
            <source src={contentUrl} type={data.mime_type} />
          </video>
        );

      case "pdf":
        return (
          <iframe
            src={contentUrl}
            title={data.caption || fileName}
            referrerPolicy="no-referrer"
            onLoad={onLoad}
            onError={onError}
            style={{
              width: "100%",
              height: isModal ? "85vh" : 500,
              maxWidth: isModal ? "90vw" : "100%",
              border: "none",
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
          {/* Media content */}
          <div
            style={{
              position: "relative",
              display: "flex",
              justifyContent: "center",
              padding: data.media_type === "audio" ? "12px 16px" : 0,
            }}
          >
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
                }}
              >
                Loading...
              </div>
            )}
            {renderMedia(false)}
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

          {/* Footer: filename, size, caption */}
          <div
            style={{
              padding: "8px 12px",
              borderTop: "1px solid var(--border)",
              fontSize: 12,
              color: "var(--text-muted)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span
                style={{
                  fontWeight: 500,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {fileName}
              </span>
              <span style={{ flexShrink: 0, marginLeft: 8 }}>{data.file_size > 0 ? formatFileSize(data.file_size) : data.url ? "URL" : ""}</span>
            </div>
            {data.caption && <div style={{ fontStyle: "italic" }}>{data.caption}</div>}
          </div>
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
              {renderMedia(true)}
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
