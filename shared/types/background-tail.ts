/**
 * Live tail of a background Bash call's output — the REST shape of
 * `GET /api/chats/:id/background-tasks/:toolUseId/tail`.
 *
 * A tool call can have several streams: the engine's own `.output` file
 * (stdout and stderr interleaved, for `run_in_background` calls) and any
 * files the command itself redirects to (`> rsync.log 2> rsync.err`). Every
 * path is derived server-side from the transcript; the client only ever
 * names a stream by its id.
 *
 * This is a polled REST response, not part of the stream wire surface
 * (`stream.ts`), but the same courtesy applies: add optional fields rather
 * than changing existing ones.
 */

/** Why a stream could not be read. Absent when it was read fine. */
export type BackgroundTailStreamError = "missing" | "not_regular" | "unreadable" | "refused";

export interface BackgroundTailStream {
  /** `"output"` for the engine file, `"r0"`…`"r7"` for redirect targets, in command order. Stable: derived from the immutable command. */
  id: string;
  kind: "engine" | "redirect";
  /** Short label, e.g. `"output"`, `"stdout → rsync.log"`, `"stdout+stderr → build.log"`, `"tee → out.log"`. */
  label: string;
  /** Path for display, with the home directory shortened to `~`. */
  displayPath: string;
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  error?: BackgroundTailStreamError;
}

export interface BackgroundTailChunk {
  stream: string;
  size: number;
  mtimeMs: number;
  /** The request's `since` matched this stream's size and mtime; `lines` is omitted. */
  unchanged?: boolean;
  lines?: string[];
  /** Only the end of the file was read (or more lines existed than were returned). */
  truncated?: boolean;
  /** The file looks binary; no lines are returned. */
  binary?: boolean;
}

export interface BackgroundTailResponse {
  toolUseId: string;
  /** The engine's background task id, when the call was a `run_in_background` launch. */
  taskId?: string;
  streams: BackgroundTailStream[];
  /** Most recently written existing, non-empty stream (ties go to `"output"`); null when none has content. */
  defaultStream: string | null;
  /** Tail of the requested stream, or of `defaultStream` when none was requested. */
  tail: BackgroundTailChunk | null;
}
