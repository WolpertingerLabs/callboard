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
        "Render a file in the chat UI. Supports images, audio, video, and PDFs. Use this when the user would benefit from seeing a file rather than just hearing about it. Requires an absolute file path.",
        {
          file_path: z.string().describe("Absolute path to the file to render"),
          display_mode: z
            .enum(["inline", "fullscreen"])
            .optional()
            .describe("inline = compact view in chat flow; fullscreen = expanded modal view (default: inline)"),
          caption: z.string().optional().describe("Optional caption shown below the rendered file"),
        },
        async (args) => {
          // Validate absolute path
          if (!path.isAbsolute(args.file_path)) {
            return error("file_path must be an absolute path");
          }
          if (args.file_path.includes("\0")) {
            return error("Invalid file path");
          }

          // Resolve and check existence
          const resolved = path.resolve(args.file_path);
          if (!existsSync(resolved)) {
            return error(`File not found: ${resolved}`);
          }

          // Determine media type
          const ext = path.extname(resolved).toLowerCase();
          const info = MIME_MAP[ext];
          if (!info) {
            return error(`Unsupported file type: ${ext}`);
          }

          // Get file size
          const stat = statSync(resolved);
          if (!stat.isFile()) {
            return error("Path is not a regular file");
          }

          const MAX_SIZE = 100 * 1024 * 1024; // 100MB
          if (stat.size > MAX_SIZE) {
            return error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 100MB)`);
          }

          // Return metadata only
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
                }),
              },
            ],
          };
        },
      ),
    ],
  });
}
