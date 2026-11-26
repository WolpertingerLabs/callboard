/**
 * Locating the Claude Code CLI's own output file for a background Bash task.
 *
 * The CLI writes a `run_in_background` task's stdout and stderr, interleaved,
 * to `<root>/<sanitised cwd>/<sessionId>/tasks/<taskId>.output`, where
 * `<root>` is `$CLAUDE_CODE_TMPDIR || os.tmpdir()` joined with
 * `claude-<uid>`. It creates the root 0700 and refuses it if it is a symlink
 * or owned by someone else; we hold it to the same rules.
 *
 * The path printed in the tool_result ("Output is being written to: …") is
 * the primary source — it is right even when the CLI ran with a
 * `CLAUDE_CODE_TMPDIR` this process cannot see. The derived path is the
 * fallback. Both must pass {@link validateEngineOutputPath}, which checks the
 * path's shape against the transcript's own session and task ids rather
 * than trusting a fixed root, and refuses symlinks below the root — that
 * also excludes subagent task entries, which the CLI links rather than
 * writes.
 */
import { lstat, realpath } from "fs/promises";
import type { Stats } from "fs";
import os from "os";
import path from "path";
import { folderToProjectDir } from "../../utils/paths.js";

export const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uid(): number {
  return process.getuid?.() ?? 0;
}

/** `$CLAUDE_CODE_TMPDIR || os.tmpdir()` + `claude-<uid>` — the CLI's own task root, as seen by this process. */
export function claudeTasksRoot(): string {
  return path.join(process.env.CLAUDE_CODE_TMPDIR || os.tmpdir(), `claude-${uid()}`);
}

/** The `.output` path the CLI printed in a background launch's tool_result, if any. */
export function parseOutputPathFromResult(text: string | undefined | null): string | null {
  if (typeof text !== "string") return null;
  const m = /Output is being written to: (\/[^\n]+?\.output)\./.exec(text);
  return m ? m[1] : null;
}

export type EngineOutputCheck = { ok: true; path: string; stat: Stats } | { ok: false; path: string; error: "missing" | "refused" };

function isEnoent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Check that `candidate` is the CLI's output file for exactly this session
 * and task: shape, root ownership and mode, no symlinks below the root, and a
 * regular file (not a symlink) at the end. `missing` is a normal state — the
 * CLI tidies these up — and is only reported for a path whose shape is right.
 */
export async function validateEngineOutputPath(candidate: string, ids: { sessionId: string; taskId: string }): Promise<EngineOutputCheck> {
  const refused = { ok: false as const, path: candidate, error: "refused" as const };
  const { sessionId, taskId } = ids;
  if (!TASK_ID.test(taskId) || !SESSION_ID.test(sessionId)) return refused;
  if (typeof candidate !== "string" || candidate.includes("\0") || !path.isAbsolute(candidate)) return refused;
  if (path.normalize(candidate) !== candidate) return refused;

  const tasksDir = path.dirname(candidate);
  const sessionDir = path.dirname(tasksDir);
  const projectDir = path.dirname(sessionDir);
  const root = path.dirname(projectDir);
  const project = path.basename(projectDir);
  if (path.basename(candidate) !== `${taskId}.output`) return refused;
  if (path.basename(tasksDir) !== "tasks") return refused;
  if (path.basename(sessionDir) !== sessionId) return refused;
  if (!project || project === "." || project === ".." || project.includes("/")) return refused;
  if (path.basename(root) !== `claude-${uid()}`) return refused;

  let rootStat: Stats;
  try {
    rootStat = await lstat(root);
  } catch (err) {
    return isEnoent(err) ? { ok: false, path: candidate, error: "missing" } : refused;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return refused;
  if (rootStat.uid !== uid() || (rootStat.mode & 0o022) !== 0) return refused;

  // No symlinks between the root and the file. The root's own ancestors are
  // the CLI's choice (macOS's /var → /private/var), so compare against the
  // resolved root rather than requiring the whole path to be physical.
  try {
    const realRoot = await realpath(root);
    const realTasks = await realpath(tasksDir);
    if (realTasks !== path.join(realRoot, project, sessionId, "tasks")) return refused;
  } catch (err) {
    return isEnoent(err) ? { ok: false, path: candidate, error: "missing" } : refused;
  }

  let st: Stats;
  try {
    st = await lstat(candidate);
  } catch (err) {
    return isEnoent(err) ? { ok: false, path: candidate, error: "missing" } : refused;
  }
  if (!st.isFile()) return refused;
  return { ok: true, path: candidate, stat: st };
}

/**
 * The engine output file for a task: the printed path first, then the
 * derived one for each working directory the session may have used. The
 * first that exists and validates wins; otherwise the first well-formed
 * candidate is reported `missing`, and failing that the result is `refused`.
 */
export async function resolveEngineOutputPath(opts: {
  resultText?: string | null;
  /** Session id on the tool_use line. */
  sessionId: string;
  /**
   * Every session id of the chat. A transcript carried into a later session
   * repeats the launch under that session's id, while the CLI filed the
   * output under the session that really ran it; any of the chat's own ids
   * is accepted for the session segment.
   */
  sessionIds?: string[];
  taskId: string;
  cwds: (string | null | undefined)[];
}): Promise<EngineOutputCheck> {
  const allowed = [opts.sessionId, ...(opts.sessionIds ?? []).filter((s) => s !== opts.sessionId)].filter((s) => SESSION_ID.test(s));
  const candidates: { path: string; sessionId: string }[] = [];
  const push = (p: string, sessionId: string) => {
    if (!candidates.some((c) => c.path === p)) candidates.push({ path: p, sessionId });
  };
  const printed = parseOutputPathFromResult(opts.resultText);
  if (printed) {
    const printedSession = path.basename(path.dirname(path.dirname(printed)));
    push(printed, allowed.includes(printedSession) ? printedSession : opts.sessionId);
  }
  const root = claudeTasksRoot();
  for (const sessionId of allowed) {
    for (const cwd of opts.cwds) {
      if (cwd) push(path.join(root, folderToProjectDir(cwd), sessionId, "tasks", `${opts.taskId}.output`), sessionId);
    }
  }

  let missing: EngineOutputCheck | null = null;
  for (const c of candidates) {
    const check = await validateEngineOutputPath(c.path, { sessionId: c.sessionId, taskId: opts.taskId });
    if (check.ok) return check;
    if (check.error === "missing" && !missing) missing = check;
  }
  return missing ?? { ok: false, path: candidates[0]?.path ?? "", error: "refused" };
}
