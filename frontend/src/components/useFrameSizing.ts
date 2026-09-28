import { useEffect, useState, type RefObject } from "react";

const MIN_HEIGHT = 60;
const MAX_HEIGHT = 2000;
const DEFAULT_HEIGHT = 400;

/**
 * Inline sizing for a sandboxed document frame (canvases and artifacts).
 *
 * The served document carries an injected reporter that posts
 * `{ type: "canvas-resize", height, width }`; only reports whose `source` is
 * this frame's window are believed. The frame is then set to the content's
 * natural size and scaled down with a CSS transform when it is wider than the
 * container — `displayHeight` is the layout height the wrapper should take.
 */
export function useFrameSizing(iframeRef: RefObject<HTMLIFrameElement | null>, containerRef: RefObject<HTMLElement | null>, enabled: boolean) {
  const [contentHeight, setContentHeight] = useState(DEFAULT_HEIGHT);
  const [contentWidth, setContentWidth] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== "canvas-resize" || typeof e.data.height !== "number") return;
      if (iframeRef.current && e.source === iframeRef.current.contentWindow) {
        setContentHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, e.data.height)));
        if (typeof e.data.width === "number" && e.data.width > 0) setContentWidth(e.data.width);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [enabled, iframeRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  const needsScale = contentWidth > 0 && containerWidth > 0 && contentWidth > containerWidth;
  const scale = needsScale ? containerWidth / contentWidth : 1;
  return { contentHeight, contentWidth, needsScale, scale, displayHeight: contentHeight * scale };
}
