/** Runs only in an isolated worker. Uses the providers' actual search-text readers. */
import { statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { OwnedSession } from "./chat-discovery.js";

export async function searchDiscoveredContent(query: string, sessions: OwnedSession[]) {
  const keys: string[] = [],
    warnings: string[] = [];
  const needle = query.toLowerCase();
  const claude: OwnedSession[] = [];
  for (const session of sessions) {
    try {
      if (statSync(session.filePath).size > 32 * 1024 * 1024) {
        warnings.push(`${session.providerKind}: search byte budget exceeded for ${session.sessionId}`);
        continue;
      }
      if (session.providerKind === "claude-code") {
        claude.push(session);
        continue;
      }
      let text: string | null;
      switch (session.providerKind) {
        case "codex":
          text = (await import("../agents/adapters/codex/sessionParser.js")).readFirstUserPrompt(session.filePath);
          break;
        case "cline":
          text = (await import("../agents/adapters/cline/sessionParser.js")).readClineTranscriptPreview(session.filePath);
          break;
        case "acp":
          text = (await import("../agents/adapters/acp/sessionParser.js")).readAcpTranscriptPreview(session.filePath);
          break;
        case "pi":
          text = (await import("../agents/adapters/pi/sessionParser.js")).deriveSearchText(session.filePath);
          break;
        default:
          warnings.push(`Unsupported content-search provider: ${session.providerKind}`);
          continue;
      }
      if (text?.toLowerCase().includes(needle)) keys.push(JSON.stringify([session.providerKind, session.sessionId]));
    } catch (error) {
      warnings.push(`${session.providerKind}: content read failed for ${session.sessionId}: ${String(error)}`);
    }
  }
  // Same basic, case-insensitive grep as ClaudeCodeSessionProvider. Batches
  // avoid ARG_MAX; no match-count cap and no command string interpolation.
  for (let offset = 0; offset < claude.length; offset += 128) {
    const batch = claude.slice(offset, offset + 128);
    try {
      const output = execFileSync("grep", ["-il", "--", query, ...batch.map((s) => s.filePath)], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
      const paths = new Set(output.trim().split("\n"));
      for (const session of batch) if (paths.has(session.filePath)) keys.push(JSON.stringify([session.providerKind, session.sessionId]));
    } catch (error) {
      if ((error as { status?: number }).status !== 1) warnings.push(`claude-code: grep failed: ${String(error)}`);
    }
  }
  return { keys, warnings };
}
