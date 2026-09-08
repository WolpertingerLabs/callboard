import type { ParsedMessage } from "shared";
import { callboardUiTool } from "shared/types/callboard-ui-tools.js";
import type { RenderFileData } from "./MediaRenderer";
import type { RenderCanvasData } from "./CanvasRenderer";

/** UI identity AND a complete renderer contract are required. Arbitrary JSON,
 * failed envelopes, partial payloads and foreign namespaces remain generic. */
export function parseUiToolResult(use: ParsedMessage, result?: ParsedMessage | null): RenderFileData | RenderCanvasData | null {
  const tool = callboardUiTool(use.toolName ?? "", use.toolNamespace);
  if (use.type !== "tool_use" || !tool || !result || result.type !== "tool_result" || (use.toolUseId && result.toolUseId && use.toolUseId !== result.toolUseId))
    return null;
  try {
    const p = JSON.parse(result.content);
    if (!p || typeof p !== "object" || Array.isArray(p) || p.isError || p.is_error) return null;
    for (const key of ["caption", "description", "untrusted_reason"]) {
      if (p[key] !== undefined && typeof p[key] !== "string") return null;
    }
    if (tool === "render_file") {
      const path = typeof p.file_path === "string" && p.file_path.length > 0;
      const url = typeof p.url === "string" && /^https?:\/\//.test(p.url);
      if (
        p.type !== "render_file" ||
        (p.file_path !== undefined) === (p.url !== undefined) ||
        (p.file_path !== undefined && !path) ||
        (p.url !== undefined && !url) ||
        !["image", "audio", "video", "pdf"].includes(p.media_type) ||
        typeof p.mime_type !== "string" ||
        !p.mime_type ||
        !["inline", "fullscreen"].includes(p.display_mode) ||
        !Number.isFinite(p.file_size) ||
        p.file_size < 0 ||
        (p.untrusted !== undefined && typeof p.untrusted !== "boolean")
      )
        return null;
      return p as RenderFileData;
    }
    if (
      p.type !== "render_canvas" ||
      typeof p.canvas_id !== "string" ||
      !p.canvas_id ||
      !Number.isSafeInteger(p.version) ||
      p.version < 1 ||
      typeof p.name !== "string" ||
      !["html", "svg", "image"].includes(p.content_type)
    )
      return null;
    return p as RenderCanvasData;
  } catch {
    return null;
  }
}
