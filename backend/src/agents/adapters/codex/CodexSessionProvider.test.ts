/**
 * Integration tests for the Codex SessionProvider against a fixture rollout
 * tree (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`) laid down in a
 * tmpdir.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexSessionProvider } from "./CodexSessionProvider.js";

const SETTINGS_MODULE = "../../../services/agent-settings.js";
const PATHS_MODULE = "../../../utils/paths.js";

vi.mock("../../../services/agent-settings.js", () => ({
  getAgentSettings: vi.fn(),
}));

vi.mock("../../../utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/paths.js")>();
  return { ...actual, isIgnoredProjectFolder: vi.fn(() => false) };
});

const UUID_A = "019ec7f2-cd5d-7823-b2d1-6683c42bfe32";
const UUID_B = "019ec888-aaaa-7000-9000-111122223333";
const UUID_MISSING = "019ec999-bbbb-7000-9000-444455556666";

let CODEX_HOME: string;

beforeEach(async () => {
  CODEX_HOME = join(tmpdir(), `codex-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(CODEX_HOME, { recursive: true });
  const { getAgentSettings } = await import(SETTINGS_MODULE);
  vi.mocked(getAgentSettings).mockReturnValue({ codexHome: CODEX_HOME });
});

afterEach(async () => {
  rmSync(CODEX_HOME, { recursive: true, force: true });
  const { getAgentSettings } = await import(SETTINGS_MODULE);
  vi.mocked(getAgentSettings).mockReset();
  const { isIgnoredProjectFolder } = await import(PATHS_MODULE);
  vi.mocked(isIgnoredProjectFolder).mockReset();
  vi.mocked(isIgnoredProjectFolder).mockImplementation(() => false);
});

async function setIgnoredFolder(fn: (folder: string) => boolean) {
  const { isIgnoredProjectFolder } = await import(PATHS_MODULE);
  vi.mocked(isIgnoredProjectFolder).mockImplementation(fn);
}

/**
 * Write a rollout under sessions/YYYY/MM/DD. `date` controls the dir tree and
 * the embedded filename timestamp; `mtime` (optional) backdates the file so
 * sort order is deterministic regardless of write order.
 */
function writeRollout(
  threadId: string,
  opts: { cwd?: string; userPrompt?: string; date?: [string, string, string]; mtime?: Date; lines?: unknown[] } = {},
): string {
  const [yyyy, mm, dd] = opts.date ?? ["2026", "06", "14"];
  const dir = join(CODEX_HOME, "sessions", yyyy, mm, dd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${yyyy}-${mm}-${dd}T17-03-58-${threadId}.jsonl`);
  const lines = opts.lines ?? [
    {
      type: "session_meta",
      payload: { id: threadId, cwd: opts.cwd ?? "/home/cybil/project", timestamp: `${yyyy}-${mm}-${dd}T17:03:58Z`, cli_version: "0.139.0" },
    },
    { type: "response_item", payload: { type: "message", role: "developer", content: "<permissions instructions>" } },
    { type: "response_item", payload: { type: "message", role: "user", content: "<environment_context>" } },
    { type: "response_item", payload: { type: "message", role: "user", content: opts.userPrompt ?? "hello codex" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: "hi there" } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  if (opts.mtime) utimesSync(file, opts.mtime, opts.mtime);
  return file;
}

describe("discoverSessions", () => {
  it("returns [] when the sessions root does not exist", () => {
    const provider = new CodexSessionProvider();
    expect(provider.discoverSessions({ limit: 10, offset: 0 })).toEqual({ sessions: [], total: 0 });
  });

  it("walks the dated tree, sorts newest-first, and paginates", () => {
    writeRollout(UUID_A, { cwd: "/p/a", mtime: new Date("2026-06-14T10:00:00Z") });
    writeRollout(UUID_B, { cwd: "/p/b", date: ["2026", "06", "13"], mtime: new Date("2026-06-13T10:00:00Z") });
    const provider = new CodexSessionProvider();

    const all = provider.discoverSessions({ limit: 10, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.sessions.map((s) => s.sessionId)).toEqual([UUID_A, UUID_B]);
    expect(all.sessions[0]!.folder).toBe("/p/a");
    expect(all.sessions[0]!.filePath).toContain(`-${UUID_A}.jsonl`);

    const page = provider.discoverSessions({ limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.sessions.map((s) => s.sessionId)).toEqual([UUID_B]);
  });

  it("hides sessions whose folder is ignored", async () => {
    writeRollout(UUID_A, { cwd: "/p/visible" });
    writeRollout(UUID_B, { cwd: "/tmp/ignored", date: ["2026", "06", "13"] });
    await setIgnoredFolder((f) => f.startsWith("/tmp/"));
    const provider = new CodexSessionProvider();
    const result = provider.discoverSessions({ limit: 10, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.sessions[0]!.sessionId).toBe(UUID_A);
  });

  it("ignores non-rollout files and stray dirs", () => {
    writeRollout(UUID_A);
    const strayDir = join(CODEX_HOME, "sessions", "2026", "06", "14");
    writeFileSync(join(strayDir, "notes.txt"), "hello", "utf-8");
    writeFileSync(join(CODEX_HOME, "sessions", "README"), "x", "utf-8");
    const provider = new CodexSessionProvider();
    expect(provider.discoverSessions({ limit: 10, offset: 0 }).total).toBe(1);
  });
});

describe("resolveSession", () => {
  it("resolves a valid thread id to its rollout path + folder", () => {
    const file = writeRollout(UUID_A, { cwd: "/p/a" });
    const provider = new CodexSessionProvider();
    expect(provider.resolveSession(UUID_A)).toEqual({ logPath: file, folder: "/p/a", displayFolder: "/p/a" });
  });
  it("returns null for an unknown or malformed id", () => {
    writeRollout(UUID_A);
    const provider = new CodexSessionProvider();
    expect(provider.resolveSession(UUID_MISSING)).toBeNull();
    expect(provider.resolveSession("../../etc/passwd")).toBeNull();
    expect(provider.resolveSession("")).toBeNull();
  });
});

describe("parseSessionMessages", () => {
  it("parses one or more sessions, skipping unknown ids", () => {
    writeRollout(UUID_A, { userPrompt: "do a thing" });
    const provider = new CodexSessionProvider();
    const messages = provider.parseSessionMessages([UUID_A, UUID_MISSING]);
    expect(messages).toEqual([
      { role: "user", type: "text", content: "do a thing" },
      { role: "assistant", type: "text", content: "hi there" },
    ]);
  });
});

describe("getSessionPreview", () => {
  it("returns the first real user prompt", () => {
    const file = writeRollout(UUID_A, { userPrompt: "build me a widget" });
    const provider = new CodexSessionProvider();
    expect(provider.getSessionPreview(file)).toBe("build me a widget");
  });
  it("truncates to maxLength", () => {
    const file = writeRollout(UUID_A, { userPrompt: "x".repeat(50) });
    const provider = new CodexSessionProvider();
    const preview = provider.getSessionPreview(file, 10);
    expect(preview).toBe(`${"x".repeat(10)}…`);
  });
});

describe("searchSessions", () => {
  it("filters by folder and grep over the first user prompt", () => {
    writeRollout(UUID_A, { cwd: "/p/a", userPrompt: "refactor the parser" });
    writeRollout(UUID_B, { cwd: "/p/b", userPrompt: "fix the bug", date: ["2026", "06", "13"] });
    const provider = new CodexSessionProvider();

    expect(provider.searchSessions({ folder: "/p/a" }).chats.map((c) => c.sessionId)).toEqual([UUID_A]);
    expect(provider.searchSessions({ folder: "", grep: "bug" }).chats.map((c) => c.sessionId)).toEqual([UUID_B]);
    expect(provider.searchSessions({ folder: "", grep: "nothing" }).chats).toEqual([]);
  });

  it("filters by updatedAfter/updatedBefore on the file mtime", () => {
    writeRollout(UUID_A, { mtime: new Date("2026-06-10T00:00:00Z") });
    writeRollout(UUID_B, { date: ["2026", "06", "13"], mtime: new Date("2026-06-20T00:00:00Z") });
    const provider = new CodexSessionProvider();
    const after = provider.searchSessions({ folder: "", updatedAfter: "2026-06-15T00:00:00Z" });
    expect(after.chats.map((c) => c.sessionId)).toEqual([UUID_B]);
  });
});

describe("deleteSessionFiles", () => {
  it("removes the rollout for a valid id", () => {
    const file = writeRollout(UUID_A);
    const provider = new CodexSessionProvider();
    expect(existsSync(file)).toBe(true);
    provider.deleteSessionFiles(UUID_A);
    expect(existsSync(file)).toBe(false);
  });
  it("is a no-op for unknown/unsafe ids", () => {
    const file = writeRollout(UUID_A);
    const provider = new CodexSessionProvider();
    provider.deleteSessionFiles(UUID_MISSING);
    provider.deleteSessionFiles("../../etc/passwd");
    expect(existsSync(file)).toBe(true);
  });
});

describe("findSubagentFiles", () => {
  it("always returns [] — Codex has no subagent rollouts", () => {
    writeRollout(UUID_A);
    expect(new CodexSessionProvider().findSubagentFiles(UUID_A)).toEqual([]);
  });
});
