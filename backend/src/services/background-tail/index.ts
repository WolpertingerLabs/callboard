/**
 * Live tail of a background Bash call — the service behind
 * `GET /api/chats/:id/background-tasks/:toolUseId/tail`.
 *
 * Streams are the engine's `.output` file (for `run_in_background` calls)
 * followed by the files the command redirects to, in the order they appear
 * in the command. Every path comes from the chat's own transcript — the
 * command the agent ran and the launch result the CLI wrote — never from the
 * client, which only picks a stream id.
 *
 * Read policy. This adds no read access: `GET /api/files/serve` already
 * serves any regular file to a signed-in caller (see `routes/files.ts`), so
 * redirect targets are not confined to the chat's folder or the home
 * directory. What the policy does guarantee is that the request can never
 * hang or wander into pseudo-files: targets whose real path is under
 * `/proc`, `/sys` or `/dev` are refused, and only regular files are read
 * (opened non-blocking, checked with `fstat`), so a FIFO or device is
 * reported `not_regular` instead of read. Symlinked log files are allowed,
 * as they are in `files.ts`. The engine file is held to the stricter rules
 * in `engine-output.ts`.
 */
import { realpath, stat } from "fs/promises";
import os from "os";
import path from "path";
import type { BackgroundTailChunk, BackgroundTailResponse, BackgroundTailStream, BackgroundTailStreamError } from "shared/types/index.js";
import { extractRedirectTargets, looksDetached, type RedirectTarget } from "./command-redirects.js";
import { resolveEngineOutputPath, SESSION_ID } from "./engine-output.js";
import { readTail } from "./tail-reader.js";
import { findToolCall, type ChatForLookup } from "./transcript-lookup.js";

export const STREAM_ID = /^(output|r[0-7])$/;

export class BadStreamError extends Error {}

export interface TailOptions {
  stream?: string;
  lines?: number;
  /** `<size>-<mtimeMs>` from the previous response for this stream. */
  since?: string;
}

interface Source {
  stream: BackgroundTailStream;
  /** Absolute path to read, when it may be read. */
  path?: string;
  noFollow?: boolean;
  ino?: number;
}

function displayPath(p: string): string {
  const home = os.homedir();
  return home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p;
}

function redirectLabel(t: RedirectTarget): string {
  const base = path.basename(t.path);
  if (t.via === "tee") return `tee → ${base}`;
  return `${t.fds.join("+")} → ${base}`;
}

const PSEUDO = /^\/(proc|sys|dev)(\/|$)/;

async function redirectSource(id: string, t: RedirectTarget): Promise<Source> {
  const base: BackgroundTailStream = { id, kind: "redirect", label: redirectLabel(t), displayPath: displayPath(t.path), exists: false };
  const fail = (error: BackgroundTailStreamError, exists = false): Source => ({ stream: { ...base, exists, error } });
  let real: string;
  try {
    real = await realpath(t.path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return fail(code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable");
  }
  if (PSEUDO.test(real)) return fail("refused", true);
  try {
    const st = await stat(real);
    if (!st.isFile()) return fail("not_regular", true);
    return { stream: { ...base, exists: true, size: st.size, mtimeMs: st.mtimeMs }, path: real, ino: st.ino };
  } catch {
    return fail("unreadable");
  }
}

async function engineSource(
  info: { resultText: string | null; sessionId: string; cwd: string | null },
  taskId: string,
  folder: string | undefined,
): Promise<Source> {
  const check = await resolveEngineOutputPath({ resultText: info.resultText, sessionId: info.sessionId, taskId, cwds: [info.cwd, folder] });
  const base: BackgroundTailStream = { id: "output", kind: "engine", label: "output", displayPath: displayPath(check.path), exists: false };
  if (!check.ok) return { stream: { ...base, error: check.error } };
  return {
    stream: { ...base, exists: true, size: check.stat.size, mtimeMs: check.stat.mtimeMs },
    path: check.path,
    noFollow: true,
    ino: check.stat.ino,
  };
}

/**
 * Newest-written stream that has content. Strictly newer wins, so a tie
 * goes to the earlier stream — the engine file comes first.
 */
function pickDefault(streams: BackgroundTailStream[]): string | null {
  let best: BackgroundTailStream | null = null;
  for (const s of streams) {
    if (!s.exists || !s.size || s.mtimeMs === undefined) continue;
    if (!best || s.mtimeMs > (best.mtimeMs as number)) best = s;
  }
  return best?.id ?? null;
}

function parseSince(since: string | undefined): { size: number; mtimeMs: number } | null {
  if (typeof since !== "string") return null;
  const m = /^(\d+)-(\d+(?:\.\d+)?)$/.exec(since);
  return m ? { size: Number(m[1]), mtimeMs: Number(m[2]) } : null;
}

/**
 * The tail for one tool call, or null when the chat has no such call or the
 * call is not a background launch (no engine task and no detached command
 * with redirects). Throws {@link BadStreamError} for a stream id the call
 * does not have.
 */
export async function getBackgroundTail(
  chat: ChatForLookup & { folder?: string },
  toolUseId: string,
  opts: TailOptions = {},
): Promise<BackgroundTailResponse | null> {
  const info = await findToolCall(chat, toolUseId);
  if (!info || info.toolName !== "Bash") return null;

  const cwd = info.cwd ?? chat.folder ?? "";
  const targets = extractRedirectTargets(info.command, { cwd, home: os.homedir() });
  const taskId = info.taskId && SESSION_ID.test(info.sessionId) ? info.taskId : undefined;
  if (!info.taskId && !(looksDetached(info.command) && targets.length > 0)) return null;

  const sources: Source[] = [];
  if (taskId) sources.push(await engineSource(info, taskId, chat.folder));
  else if (info.taskId) {
    sources.push({ stream: { id: "output", kind: "engine", label: "output", displayPath: "", exists: false, error: "refused" } });
  }
  sources.push(...(await Promise.all(targets.map((t, i) => redirectSource(`r${i}`, t)))));

  const streams = sources.map((s) => s.stream);
  const defaultStream = pickDefault(streams);

  if (opts.stream !== undefined && !streams.some((s) => s.id === opts.stream)) throw new BadStreamError(`No stream ${opts.stream}`);
  const selected = sources.find((s) => s.stream.id === (opts.stream ?? defaultStream));

  let tail: BackgroundTailChunk | null = null;
  if (selected?.path && selected.stream.exists) {
    const since = parseSince(opts.since);
    const { size, mtimeMs } = selected.stream;
    if (since && since.size === size && since.mtimeMs === mtimeMs) {
      tail = { stream: selected.stream.id, size: size as number, mtimeMs: mtimeMs as number, unchanged: true };
    } else {
      const r = await readTail(selected.path, { lines: opts.lines, noFollow: selected.noFollow, expectIno: selected.ino });
      if (r.ok) {
        tail = {
          stream: selected.stream.id,
          size: r.size,
          mtimeMs: r.mtimeMs,
          lines: r.lines,
          ...(r.truncated && { truncated: true }),
          ...(r.binary && { binary: true }),
        };
        // Report what was read, so the next `since` matches it.
        selected.stream.size = r.size;
        selected.stream.mtimeMs = r.mtimeMs;
      } else {
        selected.stream.error = r.error;
        if (r.error === "missing") selected.stream.exists = false;
      }
    }
  }

  return { toolUseId, ...(info.taskId && { taskId: info.taskId }), streams, defaultStream, tail };
}
