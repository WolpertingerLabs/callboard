/**
 * Where pi sessions live, and what is allowed to become a path segment.
 *
 * Split out of `PiAdapter.ts` in Phase 2 so `PiSessionProvider` can reach it
 * without importing the query (and with it `ModelRuntime`, the tool bridge and
 * the whole execution half). `PiAdapter` re-exports {@link resolvePiSessionsRoot}
 * so nothing that already imported it there has to move.
 *
 * @see plans/pi-adapter.md
 * @see ../acp/transcript.ts (`isSafePathSegment` — the precedent this copies)
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../../utils/paths.js";

/** Directory name under the callboard data dir. */
export const PI_SESSIONS_DIRNAME = "pi-sessions";

/**
 * Root for pi session files.
 *
 * A **function, not a module const**. `DATA_DIR` is captured at module load, so a
 * const would freeze the path at import time and a test that sets
 * `CALLBOARD_DATA_DIR` afterwards would write into the developer's real chat list
 * — which is exactly what happened to the ACP suite (#302).
 *
 * Note this is a single flat directory rather than pi's own
 * `~/.pi/agent/sessions/<encoded-cwd>/` layout: the adapter passes an explicit
 * `sessionDir` to every `SessionManager`, so all chats land here regardless of
 * cwd. That is what makes discovery one `readdir` instead of a walk.
 */
export function resolvePiSessionsRoot(): string {
  return join(DATA_DIR, PI_SESSIONS_DIRNAME);
}

/**
 * Session ids become path segments, so anything that could escape the sessions
 * root — separators, `..`, NUL, absolute-path or drive-letter forms — is
 * rejected rather than sanitized.
 *
 * Copied from `acp/transcript.ts` deliberately rather than imported: each
 * adapter owning its own guard is the property that keeps one adapter's
 * loosening from silently widening another's. The regex is identical.
 *
 * pi has its own `assertValidSessionId` (`/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/`),
 * which *throws*. The two overlap but neither contains the other: pi additionally
 * forbids a trailing `.`/`-`/`_`, and this one additionally caps length and
 * excludes the bare `.` and `..`. Callboard checks first so an unsafe id is
 * refused quietly rather than throwing out of a session write.
 */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafePathSegment(value: unknown): value is string {
  return typeof value === "string" && SAFE_SEGMENT_RE.test(value) && value !== "." && value !== "..";
}

/**
 * pi names session files `<ISO-with-dashes>_<sessionId>.jsonl` — measured, not
 * assumed: `SessionManager.create(cwd, dir, { id: "chat-abc-123" })` produced
 * `2026-08-04T23-05-47-087Z_chat-abc-123.jsonl`.
 *
 * Callboard writes seeds and forks with the same convention so one listing and
 * one resolver cover files pi wrote and files callboard wrote.
 */
export function piSessionFileName(sessionId: string, when: Date = new Date()): string {
  return `${when.toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
}

/**
 * Absolute path of a session file, found by **filename suffix**.
 *
 * The id is not the whole filename, so resolution is a `readdir` plus a string
 * compare — no file is opened. That matters: `resolveSession` is called on every
 * chat render, and the alternative (reading each file's header) would turn a
 * directory listing into N file reads.
 *
 * Returns null for an unsafe id or when nothing matches.
 */
export function findPiSessionPath(sessionId: string, root: string = resolvePiSessionsRoot()): string | null {
  if (!isSafePathSegment(sessionId)) return null;
  const suffix = `_${sessionId}.jsonl`;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  // A bare `<id>.jsonl` is accepted too: the spike proved pi keeps whatever
  // filename it is handed when resuming, so a session file that arrived by some
  // other route should still resolve.
  const match = names.find((name) => name.endsWith(suffix)) ?? names.find((name) => name === `${sessionId}.jsonl`);
  return match ? join(root, match) : null;
}
