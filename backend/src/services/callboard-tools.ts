import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync, statSync } from "fs";
import path from "path";

const MIME_MAP: Record<string, { mime: string; category: string }> = {
  ".png": { mime: "image/png", category: "image" },
  ".jpg": { mime: "image/jpeg", category: "image" },
  ".jpeg": { mime: "image/jpeg", category: "image" },
  ".gif": { mime: "image/gif", category: "image" },
  ".webp": { mime: "image/webp", category: "image" },
  ".svg": { mime: "image/svg+xml", category: "image" },
  ".bmp": { mime: "image/bmp", category: "image" },
  ".mp3": { mime: "audio/mpeg", category: "audio" },
  ".wav": { mime: "audio/wav", category: "audio" },
  ".ogg": { mime: "audio/ogg", category: "audio" },
  ".aac": { mime: "audio/aac", category: "audio" },
  ".flac": { mime: "audio/flac", category: "audio" },
  ".mp4": { mime: "video/mp4", category: "video" },
  ".webm": { mime: "video/webm", category: "video" },
  ".mov": { mime: "video/quicktime", category: "video" },
  ".pdf": { mime: "application/pdf", category: "pdf" },
};

function error(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

export function buildCallboardToolsServer() {
  return createSdkMcpServer({
    name: "callboard-tools",
    version: "1.0.0",
    tools: [
      tool(
        "render_file",
        "Render media in the chat UI. Supports images, audio, video, and PDFs from local files (absolute path) or URLs. Use this when the user would benefit from seeing media rather than just hearing about it. Provide either file_path or url, not both. If the content is from an untrusted or suspicious source, set untrusted=true with a reason.",
        {
          file_path: z.string().optional().describe("Absolute path to a local file to render"),
          url: z.string().optional().describe("URL of media content to render (http or https)"),
          display_mode: z
            .enum(["inline", "fullscreen"])
            .optional()
            .describe("inline = compact view in chat flow; fullscreen = expanded modal view (default: inline)"),
          caption: z.string().optional().describe("Optional caption shown below the rendered media"),
          untrusted: z
            .boolean()
            .optional()
            .describe("Set to true if the content may be unsafe or from an untrusted source. The UI will show a warning gate before loading."),
          untrusted_reason: z.string().optional().describe("Human-readable reason why this content is flagged as untrusted"),
        },
        async (args) => {
          const hasFilePath = !!args.file_path;
          const hasUrl = !!args.url;

          // Exactly one source required
          if (!hasFilePath && !hasUrl) {
            return error("Provide either file_path or url");
          }
          if (hasFilePath && hasUrl) {
            return error("Provide either file_path or url, not both");
          }

          // ── URL path ──
          if (hasUrl) {
            let parsed: URL;
            try {
              parsed = new URL(args.url!);
            } catch {
              return error("Invalid URL format");
            }

            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
              return error("URL must use http or https protocol");
            }

            const ext = path.extname(parsed.pathname).toLowerCase();
            const info = MIME_MAP[ext];
            if (!info) {
              return error(`Unsupported file type or could not determine type from URL${ext ? `: ${ext}` : ""}`);
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    type: "render_file",
                    url: args.url,
                    media_type: info.category,
                    mime_type: info.mime,
                    display_mode: args.display_mode || "inline",
                    file_size: 0,
                    caption: args.caption || undefined,
                    ...(args.untrusted ? { untrusted: true, untrusted_reason: args.untrusted_reason || undefined } : {}),
                  }),
                },
              ],
            };
          }

          // ── File path ──
          if (!path.isAbsolute(args.file_path!)) {
            return error("file_path must be an absolute path");
          }
          if (args.file_path!.includes("\0")) {
            return error("Invalid file path");
          }

          const resolved = path.resolve(args.file_path!);
          if (!existsSync(resolved)) {
            return error(`File not found: ${resolved}`);
          }

          const ext = path.extname(resolved).toLowerCase();
          const info = MIME_MAP[ext];
          if (!info) {
            return error(`Unsupported file type: ${ext}`);
          }

          const stat = statSync(resolved);
          if (!stat.isFile()) {
            return error("Path is not a regular file");
          }

          const MAX_SIZE = 100 * 1024 * 1024; // 100MB
          if (stat.size > MAX_SIZE) {
            return error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 100MB)`);
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  type: "render_file",
                  file_path: resolved,
                  media_type: info.category,
                  mime_type: info.mime,
                  display_mode: args.display_mode || "inline",
                  file_size: stat.size,
                  caption: args.caption || undefined,
                  ...(args.untrusted ? { untrusted: true, untrusted_reason: args.untrusted_reason || undefined } : {}),
                }),
              },
            ],
          };
        },
      ),
    ],
  });
}
