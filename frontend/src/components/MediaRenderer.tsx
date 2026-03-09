import { useState, useEffect, useCallback } from "react";
import ModalOverlay from "./ModalOverlay";

interface RenderFileData {
  type: "render_file";
  file_path: string;
  media_type: "image" | "audio" | "video" | "pdf";
  mime_type: string;
  display_mode: "inline" | "fullscreen";
  file_size: number;
  caption?: string;
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

export default function MediaRenderer({ data }: MediaRendererProps) {
  const [expanded, setExpanded] = useState(data.display_mode === "fullscreen");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fileUrl = `/api/files/serve?path=${encodeURIComponent(data.file_path)}`;
  const fileName = getFileName(data.file_path);

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

  if (error) {
    return (
      <div
        style={{
          margin: "4px 0",
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
            src={fileUrl}
            alt={data.caption || fileName}
            onLoad={onLoad}
            onError={onError}
            onClick={!isModal ? () => setExpanded(true) : undefined}
            style={{
              maxHeight,
              maxWidth,
              objectFit: "contain",
              display: "block",
              cursor: isModal ? "default" : "pointer",
              borderRadius: isModal ? 0 : "var(--radius)",
            }}
          />
        );

      case "audio":
        return (
          <audio
            controls
            preload="metadata"
            onLoadedMetadata={onLoad}
            onError={onError}
            style={{ width: "100%", maxWidth: isModal ? "600px" : "100%" }}
          >
            <source src={fileUrl} type={data.mime_type} />
          </audio>
        );

      case "video":
        return (
          <video
            controls
            preload="metadata"
            onLoadedMetadata={onLoad}
            onError={onError}
            onClick={!isModal ? () => setExpanded(true) : undefined}
            style={{
              maxHeight,
              maxWidth,
              display: "block",
              cursor: isModal ? "default" : "pointer",
              borderRadius: isModal ? 0 : "var(--radius)",
            }}
          >
            <source src={fileUrl} type={data.mime_type} />
          </video>
        );

      case "pdf":
        return (
          <iframe
            src={fileUrl}
            title={data.caption || fileName}
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
      <div style={{ margin: "4px 0" }}>
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
              <span style={{ flexShrink: 0, marginLeft: 8 }}>{formatFileSize(data.file_size)}</span>
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
                  top: -36,
                  right: 0,
                  background: "none",
                  border: "none",
                  color: "var(--text)",
                  fontSize: 24,
                  cursor: "pointer",
                  padding: "4px 8px",
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
