import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getClaudeRetention, getEngineRetention, RetentionUpdateError, setClaudeCleanupPeriodDays, type PolicyRetention } from "./engine-retention.js";

let root: string;
let claudeDir: string;
let policy: PolicyRetention | undefined;
const settingsFile = () => join(claudeDir, "settings.json");
const deps = (extra: { allowShrink?: boolean } = {}) => ({ claudeDir, resolvePolicy: async () => policy, ...extra });
const readJson = (file = settingsFile()) => JSON.parse(readFileSync(file, "utf8"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "engine-retention-"));
  claudeDir = join(root, ".claude");
  mkdirSync(claudeDir);
  policy = undefined;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("getClaudeRetention", () => {
  it("reports the default when there is no settings file", async () => {
    const r = await getClaudeRetention(deps());
    expect(r).toMatchObject({ configuredDays: null, defaultDays: 30, effectiveDays: 30, settingsPath: settingsFile(), storagePath: join(claudeDir, "projects") });
    expect(r.managedBy).toBeUndefined();
    expect(r.unreadable).toBeUndefined();
  });

  it("reads a configured value", async () => {
    writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: 400 }));
    expect(await getClaudeRetention(deps())).toMatchObject({ configuredDays: 400, effectiveDays: 400 });
  });

  it("treats an invalid value as unconfigured", async () => {
    writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: 0 }));
    expect(await getClaudeRetention(deps())).toMatchObject({ configuredDays: null, effectiveDays: 30 });
  });

  it("lets managed policy win and names its source", async () => {
    writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: 400 }));
    policy = { days: 14, source: "/etc/claude-code/managed-settings.d/z.json" };
    expect(await getClaudeRetention(deps())).toMatchObject({ configuredDays: 400, effectiveDays: 14, managedBy: policy.source });
  });

  it("reports an invalid value Claude would reject, rather than pretending the default applies", async () => {
    writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: 0 }));
    expect(await getClaudeRetention(deps())).toMatchObject({ configuredDays: null, invalidValue: "0" });
    writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: "90" }));
    expect((await getClaudeRetention(deps())).invalidValue).toBe('"90"');
    writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: 90 }));
    expect((await getClaudeRetention(deps())).invalidValue).toBeUndefined();
  });

  it("flags an unparseable settings file", async () => {
    writeFileSync(settingsFile(), "{ not json");
    expect((await getClaudeRetention(deps())).unreadable).toBeTruthy();
  });

  it("defaults to $CLAUDE_CONFIG_DIR when set", async () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    try {
      const r = await getClaudeRetention({ resolvePolicy: async () => undefined });
      expect(r.settingsPath).toBe(settingsFile());
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe("setClaudeCleanupPeriodDays", () => {
  it("writes the key and preserves every other one", async () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] } }));
    const r = await setClaudeCleanupPeriodDays(365, deps());
    expect(r.configuredDays).toBe(365);
    expect(readJson()).toEqual({ model: "opus", permissions: { allow: ["Bash(ls)"] }, cleanupPeriodDays: 365 });
  });

  it("creates the settings file when absent", async () => {
    await setClaudeCleanupPeriodDays(90, deps());
    expect(readJson()).toEqual({ cleanupPeriodDays: 90 });
  });

  it("removes the key on null", async () => {
    // 20 → default (30) lengthens, so this needs no shrink permission.
    writeFileSync(settingsFile(), JSON.stringify({ model: "opus", cleanupPeriodDays: 20 }));
    const r = await setClaudeCleanupPeriodDays(null, deps());
    expect(r).toMatchObject({ configuredDays: null, effectiveDays: 30 });
    expect(readJson()).toEqual({ model: "opus" });
  });

  it("does not create a file just to remove a key", async () => {
    await setClaudeCleanupPeriodDays(null, deps());
    expect(() => statSync(settingsFile())).toThrow();
  });

  it.each([0, -1, 1.5, 36501, Number.NaN])("refuses %s with a 400", async (days) => {
    await expect(setClaudeCleanupPeriodDays(days, deps())).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to rewrite an unparseable file and leaves it untouched", async () => {
    writeFileSync(settingsFile(), "{ not json");
    await expect(setClaudeCleanupPeriodDays(90, deps())).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(settingsFile(), "utf8")).toBe("{ not json");
  });

  it("refuses when the Claude config dir does not exist", async () => {
    rmSync(claudeDir, { recursive: true });
    await expect(setClaudeCleanupPeriodDays(90, deps())).rejects.toMatchObject({ status: 409 });
  });

  it("refuses while managed policy pins the value", async () => {
    policy = { days: 14, source: "a macOS configuration profile" };
    await expect(setClaudeCleanupPeriodDays(90, deps())).rejects.toMatchObject({ status: 409 });
    expect(() => statSync(settingsFile())).toThrow();
  });

  describe("shortening", () => {
    beforeEach(() => writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: 365 })));

    it("is refused with 403 unless allowed, and the file is untouched", async () => {
      await expect(setClaudeCleanupPeriodDays(90, deps())).rejects.toMatchObject({ status: 403 });
      expect(readJson()).toEqual({ cleanupPeriodDays: 365 });
    });

    it("counts resetting to a shorter default as shortening", async () => {
      await expect(setClaudeCleanupPeriodDays(null, deps())).rejects.toBeInstanceOf(RetentionUpdateError);
    });

    it("is allowed when allowShrink is set", async () => {
      await setClaudeCleanupPeriodDays(90, deps({ allowShrink: true }));
      expect(readJson()).toEqual({ cleanupPeriodDays: 90 });
    });

    it("treats two values at or past the ceiling as equal, not as shortening", async () => {
      writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: 99999 }));
      await setClaudeCleanupPeriodDays(36500, deps());
      expect(readJson()).toEqual({ cleanupPeriodDays: 36500 });
    });

    it.each([0, "90", -5, 1.5])("treats an invalid current value %j as 'nothing is deleted', so any write needs allowShrink", async (raw) => {
      writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: raw }));
      await expect(setClaudeCleanupPeriodDays(31, deps())).rejects.toMatchObject({ status: 403 });
      await expect(setClaudeCleanupPeriodDays(null, deps())).rejects.toMatchObject({ status: 403 });
      expect(readJson()).toEqual({ cleanupPeriodDays: raw });
      await setClaudeCleanupPeriodDays(31, deps({ allowShrink: true }));
      expect(readJson()).toEqual({ cleanupPeriodDays: 31 });
    });

    it("does not gate lengthening", async () => {
      await setClaudeCleanupPeriodDays(36500, deps());
      expect(readJson()).toEqual({ cleanupPeriodDays: 36500 });
    });
  });

  describe.skipIf(process.platform === "win32")("POSIX file handling", () => {
    it("keeps the file's permission bits", async () => {
      writeFileSync(settingsFile(), "{}");
      chmodSync(settingsFile(), 0o600);
      await setClaudeCleanupPeriodDays(90, deps());
      expect(statSync(settingsFile()).mode & 0o777).toBe(0o600);
    });

    it("writes through a symlinked settings file instead of replacing the link", async () => {
      const dotfiles = join(root, "dotfiles");
      mkdirSync(dotfiles);
      const real = join(dotfiles, "claude-settings.json");
      writeFileSync(real, JSON.stringify({ model: "opus" }));
      symlinkSync(real, settingsFile());
      await setClaudeCleanupPeriodDays(90, deps());
      expect(lstatSync(settingsFile()).isSymbolicLink()).toBe(true);
      expect(readJson(real)).toEqual({ model: "opus", cleanupPeriodDays: 90 });
    });

    it.skipIf(process.getuid?.() === 0)("maps a non-writable target to a 409 that says so", async () => {
      const store = join(root, "store");
      mkdirSync(store);
      const real = join(store, "settings.json");
      writeFileSync(real, "{}");
      symlinkSync(real, settingsFile());
      chmodSync(store, 0o555);
      try {
        await expect(setClaudeCleanupPeriodDays(90, deps())).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/not writable/) });
      } finally {
        chmodSync(store, 0o755);
      }
    });

    it("refuses a dangling symlink", async () => {
      symlinkSync(join(root, "missing.json"), settingsFile());
      await expect(setClaudeCleanupPeriodDays(90, deps())).rejects.toMatchObject({ status: 409 });
      expect(lstatSync(settingsFile()).isSymbolicLink()).toBe(true);
    });
  });
});

describe("getEngineRetention", () => {
  it("reports Codex and pi as non-expiring", async () => {
    const all = await getEngineRetention(deps());
    expect(all.map((r) => [r.engine, r.expires])).toEqual([
      ["claude-code", true],
      ["codex", false],
      ["pi", false],
    ]);
  });
});
