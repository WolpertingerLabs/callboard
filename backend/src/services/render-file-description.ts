/**
 * The render_file tool description: the definition the model sees
 * (callboard-tools.ts) and the copy the UI lists (mcp-tool-registry.ts) both
 * use this one string, so they cannot drift. Its own module so the registry
 * need not import the whole tool server.
 */
export const RENDER_FILE_DESCRIPTION =
  "Render a file in the chat UI. Images (png, jpg, gif, webp, avif, svg, …), audio (mp3, m4a, wav, ogg/opus, flac, …), video (mp4, m4v, webm, mov, ogv) and PDFs render inline; any other local file is shown as a download card with name, size and type. Local files (absolute path) or http(s) URLs to media; URLs must point at a supported media type. Provide either file_path or url, not both. If the content is from an untrusted or suspicious source, set untrusted=true with a reason.";
