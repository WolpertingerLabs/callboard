import { useEffect, useRef, useState } from "react";
import { Download, File as FileIcon, ShieldAlert } from "lucide-react";
import type { RenderFileMediaType } from "shared/types/callboard-ui-tools.js";
import FullscreenFrame, { FullscreenButton } from "./FullscreenFrame";
import { useGalleryItem, useHasChatGallery } from "./gallery/ChatGallery";
import { BYTES_UP_TO_GB, formatBytes } from "../utils/formatBytes";

export interface RenderFileData {
  type: "render_file";
  file_path?: string;
  url?: string;
  /** `file`: no inline renderer; shown as a download card (local paths only). */
  media_type: RenderFileMediaType;
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

/** `/api/files/serve?…&download=1`: always an octet-stream attachment. Local paths only. */
function downloadUrl(filePath: string): string {
  return `/api/files/serve?path=${encodeURIComponent(filePath)}&download=1`;
}

const downloadLinkStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  fontSize: 13,
  fontWeight: 500,
  background: "var(--accent)",
  color: "var(--text-on-accent)",
  borderRadius: 6,
  textDecoration: "none",
  flexShrink: 0,
} as const;

/** The card for a `file` result: name, size, type and a Download button. No preview. */
function FileCard({ data, fileName }: { data: RenderFileData; fileName: string }) {
  return (
    <div style={{ margin: "4px 0", maxWidth: "92%" }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--surface)",
          padding: "12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <FileIcon size={28} aria-hidden="true" style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
            <span
              title={data.file_path}
              style={{ fontWeight: 500, fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {fileName}
            </span>
            <span style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {formatBytes(data.file_size, BYTES_UP_TO_GB)} · {data.mime_type}
            </span>
          </div>
          {data.file_path && (
            <a href={downloadUrl(data.file_path)} download={fileName} style={downloadLinkStyle}>
              <Download size={14} aria-hidden="true" />
              Download
            </a>
          )}
        </div>
        {data.caption && <div style={{ fontSize: 12, fontStyle: "italic", color: "var(--text-muted)" }}>{data.caption}</div>}
      </div>
    </div>
  );
}

export default function MediaRenderer({ data }: MediaRendererProps) {
  // Images and videos in a chat open the chat-wide gallery (swipe, and
  // pinch-zoom for images) instead of FullscreenFrame; audio and PDFs keep
  // FullscreenFrame.
  const galleryKind = data.media_type === "image" || data.media_type === "video" ? data.media_type : null;
  const inGallery = useHasChatGallery() && galleryKind !== null;
  const [expanded, setExpanded] = useState(data.display_mode === "fullscreen" && !inGallery);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [trustDismissed, setTrustDismissed] = useState(false);

  const contentUrl = data.url ? `/api/files/serve?url=${encodeURIComponent(data.url)}` : `/api/files/serve?path=${encodeURIComponent(data.file_path!)}`;
  const fileName = data.url ? getFileNameFromUrl(data.url) : getFileName(data.file_path!);

  // Media joins the gallery only once it is actually shown: never while it
  // is behind the untrusted-content gate, and not after it failed to load.
  const mediaRef = useRef<HTMLDivElement>(null);
  const gated = !!data.untrusted && !trustDismissed;
  const openInGallery = useGalleryItem(
    mediaRef,
    galleryKind && !gated && !error
      ? { src: contentUrl, alt: data.caption || fileName, caption: data.caption, referrerPolicy: "no-referrer", kind: galleryKind }
      : null,
  );

  // display_mode "fullscreen" opens the gallery at this media as soon as it
  // can — on mount, or right after "View anyway" for a gated image — once.
  // As an "auto" open it never takes over a viewer that is already open.
  const autoOpenPending = useRef(data.display_mode === "fullscreen" && inGallery);
  useEffect(() => {
    if (!autoOpenPending.current || !openInGallery) return;
    autoOpenPending.current = false;
    openInGallery("auto");
  }, [openInGallery]);

  const onLoad = () => setLoading(false);
  // Whichever arrives first: some browsers (iOS) may not fetch metadata for
  // preload="metadata" until the user presses play.
  const mediaLoadHandlers = { onLoadedMetadata: onLoad, onLoadedData: onLoad, onCanPlay: onLoad };
  const timedMedia = data.media_type === "audio" || data.media_type === "video";
  const onError = () => {
    setLoading(false);
    setError(true);
  };

  // Untrusted content gate
  if (data.untrusted && !trustDismissed) {
    return (
      <div style={{ margin: "4px 0", maxWidth: "92%" }}>
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
            {data.media_type === "file" && (
              <div>
                <span style={{ fontWeight: 500 }}>Size: </span>
                {formatBytes(data.file_size, BYTES_UP_TO_GB)}
              </div>
            )}
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

  if (data.media_type === "file") return <FileCard data={data} fileName={fileName} />;

  if (error) {
    return (
      <div
        style={{
          margin: "4px 0",
          maxWidth: "92%",
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
            // Inline, a tap on the picture itself opens the gallery — the
            // fullscreen button is a small target on a phone.
            onClick={!isModal && openInGallery ? () => openInGallery() : undefined}
            style={{
              maxHeight,
              maxWidth,
              objectFit: "contain",
              display: "block",
              cursor: !isModal && openInGallery ? "zoom-in" : undefined,
              borderRadius: isModal ? 0 : "var(--radius)",
            }}
          />
        );

      case "audio":
        return (
          // `src` on the element, not a <source> child: a <source> that fails
          // fires `error` on itself (it doesn't bubble), so the media
          // element's onError would never run.
          <audio
            src={contentUrl}
            controls
            preload="metadata"
            {...mediaLoadHandlers}
            onError={onError}
            style={{ width: "100%", maxWidth: isModal ? "600px" : "100%" }}
          />
        );

      case "video":
        return (
          // `src` on the element for the same reason as <audio> above.
          <video
            src={contentUrl}
            controls
            playsInline
            preload="metadata"
            {...mediaLoadHandlers}
            onError={onError}
            style={{
              maxHeight,
              maxWidth,
              display: "block",
              borderRadius: isModal ? 0 : "var(--radius)",
            }}
          />
        );

      case "pdf":
        // This iframe is NOT sandboxed, and a real PDF in it is same-origin with the
        // app. Chromium refuses to show a PDF in any sandboxed iframe, whatever the
        // flags (even every allow-* at once), and it ignores the response's CSP
        // `sandbox` for a PDF as well. What makes it safe is the type:
        // /api/files/serve sends `application/pdf` (from the file's extension, never
        // the upstream's Content-Type) with nosniff, so the browser's PDF viewer
        // handles it, and Chromium runs any PDF JavaScript inside PDFium, off the app
        // origin. The response's `default-src 'none'; sandbox` CSP only matters for
        // bytes that are not a PDF (say, an .svg labelled pdf): those get an opaque
        // origin and no script. Never point this iframe at a URL whose type the
        // server does not force.
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
      <div style={{ margin: "4px 0", maxWidth: "92%" }}>
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
            ref={mediaRef}
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
                  // Never in the way of the native controls underneath.
                  pointerEvents: timedMedia ? "none" : undefined,
                }}
              >
                Loading...
              </div>
            )}
            {renderMedia(false)}
            {/* Fullscreen button */}
            {/* Video gets it while loading too: iOS may not load metadata until play. */}
            {(!loading || data.media_type === "video") && <FullscreenButton onClick={openInGallery ? () => openInGallery() : () => setExpanded(true)} />}
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
              <span style={{ flexShrink: 0, marginLeft: 8, display: "flex", alignItems: "center", gap: 8 }}>
                {data.file_size > 0 ? formatBytes(data.file_size) : data.url ? "URL" : ""}
                {/* Saving inline media is awkward on iOS; this always downloads. */}
                {data.file_path && (
                  <a
                    href={downloadUrl(data.file_path)}
                    download={fileName}
                    title="Download"
                    aria-label={`Download ${fileName}`}
                    // A 32px hit area around the 14px icon, without growing the footer.
                    style={{ display: "flex", color: "var(--text-muted)", padding: 9, margin: -9 }}
                  >
                    <Download size={14} aria-hidden="true" />
                  </a>
                )}
              </span>
            </div>
            {data.caption && <div style={{ fontStyle: "italic" }}>{data.caption}</div>}
          </div>
        </div>
      </div>

      {/* Fullscreen modal */}
      {expanded && (
        <FullscreenFrame onClose={() => setExpanded(false)} caption={data.caption}>
          {renderMedia(true)}
        </FullscreenFrame>
      )}
    </>
  );
}
