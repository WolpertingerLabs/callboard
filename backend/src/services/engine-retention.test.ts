import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getClaudeRetention, getEngineRetention, RetentionUpdateError, setClaudeCleanupPeriodDays } from "./engine-retention.js";

let root: string;
let claudeDir: string;
let managedFile: string;
const settingsFile = () => join(claudeDir, "settings.json");
const paths = () => ({ claudeDir, managedFiles: [managedFile] });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "engine-retention-"));
  claudeDir = join(root, ".claude");
  mkdirSync(claudeDir);
  managedFile = join(root, "managed-settings.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("getClaudeRetention", () => {
  it("reports the default when there is no settings file", () => {
    const r = getClaudeRetention(paths());
    expect(r).toMatchObject({ configuredDays: null, defaultDays: 30, effectiveDays: 30, settingsPath: settingsFile(), storagePath: join(claudeDir, "projects") });
    expect(r.managedBy).toBeUndefined();
    expect(r.unreadable).toBeUndefined();
  });

  it("reads a configured value", () => {
    writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: 400 }));
    expect(getClaudeRetention(paths())).toMatchObject({ configuredDays: 400, effectiveDays: 400 });
  });

  it("treats an invalid value as unconfigured", () => {
    writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: 0 }));
    expect(getClaudeRetention(paths())).toMatchObject({ configuredDays: null, effectiveDays: 30 });
  });

  it("lets managed policy win and names its file", () => {
    writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: 400 }));
    writeFileSync(managedFile, JSON.stringify({ cleanupPeriodDays: 14 }));
    expect(getClaudeRetention(paths())).toMatchObject({ configuredDays: 400, effectiveDays: 14, managedBy: managedFile });
  });

  it("flags an unparseable settings file", () => {
    writeFileSync(settingsFile(), "{ not json");
    expect(getClaudeRetention(paths()).unreadable).toBeTruthy();
  });
});

describe("setClaudeCleanupPeriodDays", () => {
  it("writes the key and preserves every other one", () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] } }));
    const r = setClaudeCleanupPeriodDays(365, paths());
    expect(r.configuredDays).toBe(365);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ model: "opus", permissions: { allow: ["Bash(ls)"] }, cleanupPeriodDays: 365 });
  });

  it("creates the settings file when absent", () => {
    setClaudeCleanupPeriodDays(90, paths());
    expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ cleanupPeriodDays: 90 });
  });

  it("removes the key on null", () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: "opus", cleanupPeriodDays: 90 }));
    const r = setClaudeCleanupPeriodDays(null, paths());
    expect(r).toMatchObject({ configuredDays: null, effectiveDays: 30 });
    expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ model: "opus" });
  });

  it("does not create a file just to remove a key", () => {
    setClaudeCleanupPeriodDays(null, paths());
    expect(() => statSync(settingsFile())).toThrow();
  });

  it.each([0, -1, 1.5, 36501, Number.NaN])("refuses %s", (days) => {
    expect(() => setClaudeCleanupPeriodDays(days, paths())).toThrow(RetentionUpdateError);
  });

  it("refuses to rewrite an unparseable file and leaves it untouched", () => {
    writeFileSync(settingsFile(), "{ not json");
    expect(() => setClaudeCleanupPeriodDays(90, paths())).toThrow(expect.objectContaining({ status: 409 }));
    expect(readFileSync(settingsFile(), "utf8")).toBe("{ not json");
  });

  it("refuses when the Claude config dir does not exist", () => {
    rmSync(claudeDir, { recursive: true });
    expect(() => setClaudeCleanupPeriodDays(90, paths())).toThrow(expect.objectContaining({ status: 409 }));
  });

  it.skipIf(process.platform === "win32")("keeps the file's permission bits", () => {
    writeFileSync(settingsFile(), "{}");
    chmodSync(settingsFile(), 0o600);
    setClaudeCleanupPeriodDays(90, paths());
    expect(statSync(settingsFile()).mode & 0o777).toBe(0o600);
  });
});

describe("getEngineRetention", () => {
  it("reports Codex and pi as non-expiring", () => {
    const all = getEngineRetention(paths());
    expect(all.map((r) => [r.engine, r.expires])).toEqual([
      ["claude-code", true],
      ["codex", false],
      ["pi", false],
    ]);
  });
});
