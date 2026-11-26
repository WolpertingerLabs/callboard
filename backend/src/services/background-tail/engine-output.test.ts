import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { claudeTasksRoot, parseOutputPathFromResult, resolveEngineOutputPath, validateEngineOutputPath } from "./engine-output.js";
import { folderToProjectDir } from "../../utils/paths.js";

const SID = "f17cfdb7-ee9f-4481-9b84-e5e037683103";
const TASK = "bh0skech1";
const CWD = "/home/u/my.project";

let base: string;
let root: string;
let tasks: string;
let file: string;
const prevEnv = process.env.CLAUDE_CODE_TMPDIR;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "bgtail-engine-"));
  process.env.CLAUDE_CODE_TMPDIR = base;
  root = claudeTasksRoot();
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  tasks = join(root, folderToProjectDir(CWD), SID, "tasks");
  mkdirSync(tasks, { recursive: true });
  file = join(tasks, `${TASK}.output`);
  writeFileSync(file, "hello\n");
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
  else process.env.CLAUDE_CODE_TMPDIR = prevEnv;
  rmSync(base, { recursive: true, force: true });
});

const launchText = (p: string) =>
  `Command running in background with ID: ${TASK}. Output is being written to: ${p}. You will be notified when it completes. To check interim output, use Read on that file path.`;

describe("parseOutputPathFromResult", () => {
  it("reads the CLI's launch text", () => {
    expect(parseOutputPathFromResult(launchText("/tmp/claude-1000/-a-b/" + SID + "/tasks/x.output"))).toBe(`/tmp/claude-1000/-a-b/${SID}/tasks/x.output`);
  });
  it("returns null for anything else", () => {
    expect(parseOutputPathFromResult("done")).toBeNull();
    expect(parseOutputPathFromResult(undefined)).toBeNull();
  });
});

describe("validateEngineOutputPath", () => {
  const ids = { sessionId: SID, taskId: TASK };

  it("accepts the real layout", async () => {
    const r = await validateEngineOutputPath(file, ids);
    expect(r.ok).toBe(true);
  });

  it("reports a well-formed but absent file as missing", async () => {
    rmSync(file);
    expect(await validateEngineOutputPath(file, ids)).toMatchObject({ ok: false, error: "missing" });
  });

  it("rejects the wrong session id segment", async () => {
    const other = "00000000-0000-4000-8000-000000000000";
    expect(await validateEngineOutputPath(file, { sessionId: other, taskId: TASK })).toMatchObject({ error: "refused" });
  });

  it("rejects the wrong basename", async () => {
    expect(await validateEngineOutputPath(join(tasks, "other.output"), ids)).toMatchObject({ error: "refused" });
  });

  it("rejects .. in the path", async () => {
    expect(await validateEngineOutputPath(`${tasks}/../tasks/${TASK}.output`, ids)).toMatchObject({ error: "refused" });
  });

  it("rejects an invalid task id", async () => {
    expect(await validateEngineOutputPath(file, { sessionId: SID, taskId: "../x" })).toMatchObject({ error: "refused" });
  });

  it("rejects a symlinked .output (the subagent case)", async () => {
    const target = join(base, "elsewhere.txt");
    writeFileSync(target, "secret\n");
    rmSync(file);
    symlinkSync(target, file);
    expect(await validateEngineOutputPath(file, ids)).toMatchObject({ error: "refused" });
  });

  it("rejects a symlinked parent directory", async () => {
    const real = join(base, "real-session");
    mkdirSync(join(real, "tasks"), { recursive: true });
    writeFileSync(join(real, "tasks", `${TASK}.output`), "x\n");
    const linkedSession = "11111111-1111-4111-8111-111111111111";
    symlinkSync(real, join(root, folderToProjectDir(CWD), linkedSession));
    const p = join(root, folderToProjectDir(CWD), linkedSession, "tasks", `${TASK}.output`);
    expect(await validateEngineOutputPath(p, { sessionId: linkedSession, taskId: TASK })).toMatchObject({ error: "refused" });
  });

  it("rejects a root writable by group or others", async () => {
    chmodSync(root, 0o775);
    expect(await validateEngineOutputPath(file, ids)).toMatchObject({ error: "refused" });
  });

  it("rejects a root not named claude-<uid>", async () => {
    const bad = join(base, "claude-x", "p", SID, "tasks", `${TASK}.output`);
    expect(await validateEngineOutputPath(bad, ids)).toMatchObject({ error: "refused" });
  });
});

describe("resolveEngineOutputPath", () => {
  it("uses the printed path", async () => {
    const r = await resolveEngineOutputPath({ resultText: launchText(file), sessionId: SID, taskId: TASK, cwds: [] });
    expect(r).toMatchObject({ ok: true, path: file });
  });

  it("falls back to the derived path when the text has none", async () => {
    const r = await resolveEngineOutputPath({ resultText: "", sessionId: SID, taskId: TASK, cwds: ["/nowhere", CWD] });
    expect(r).toMatchObject({ ok: true, path: file });
  });

  it("falls back when the printed path is refused", async () => {
    const r = await resolveEngineOutputPath({ resultText: launchText("/etc/passwd.output"), sessionId: SID, taskId: TASK, cwds: [CWD] });
    expect(r).toMatchObject({ ok: true, path: file });
  });

  it("reports missing once the CLI has cleaned up", async () => {
    rmSync(file);
    const r = await resolveEngineOutputPath({ resultText: launchText(file), sessionId: SID, taskId: TASK, cwds: [CWD] });
    expect(r).toMatchObject({ ok: false, error: "missing", path: file });
  });
});
