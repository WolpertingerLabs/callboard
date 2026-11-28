/**
 * The repo-config trust gate (H-02): decision matrix, trust matching (including
 * the forged-worktree case), the config scan and the lockdown settings object.
 * `claude.repoHooks.sdk.test.ts` checks the same through the real CLI.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-trust-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const root = realpathSync(mkdtempSync(join(tmpdir(), "callboard-trust-fs-")));

const trust = await import("./repo-config-trust.js");
const {
  decideRepoConfig,
  isFolderTrusted,
  trustFolder,
  untrustFolder,
  readTrustedFolders,
  scanRepoExecutableConfig,
  repoLockdownSettings,
  TRUSTED_FOLDERS_FILE,
} = trust;

afterEach(() => rmSync(TRUSTED_FOLDERS_FILE, { force: true }));
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function dir(...parts: string[]): string {
  const d = join(root, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

describe("decideRepoConfig", () => {
  const cwd = dir("decide");
  const cases: [string | null, "trusted" | "always" | "never" | undefined, boolean, boolean, string][] = [];
  for (const codeExecution of ["allow", "ask", "deny", null] as const)
    for (const mode of ["trusted", "always", "never", undefined] as const)
      for (const trusted of [true, false]) {
        let run = false;
        let reason = "code-execution-not-allowed";
        if (codeExecution === "allow") {
          if (mode === "never") reason = "setting-never";
          else if (mode === "always") [run, reason] = [true, "always"];
          else [run, reason] = trusted ? [true, "trusted"] : [false, "untrusted-folder"];
        }
        cases.push([codeExecution, mode, trusted, run, reason]);
      }

  it.each(cases)("codeExecution=%s mode=%s trusted=%s → run=%s (%s)", (codeExecution, mode, trusted, run, reason) => {
    if (trusted) trustFolder(cwd);
    expect(decideRepoConfig({ cwd, codeExecution: codeExecution as never, mode })).toMatchObject({ run, reason });
  });

  it("an unknown mode reads as trusted", () => {
    expect(decideRepoConfig({ cwd, codeExecution: "allow", mode: "bogus" as never }).reason).toBe("untrusted-folder");
  });
});

describe("trust store and matching", () => {
  it("trusts the folder and everything under it, on a path-segment boundary", () => {
    const repo = dir("m", "repo");
    const sub = dir("m", "repo", "a", "b");
    const sibling = dir("m", "repo2");
    trustFolder(repo);
    expect(isFolderTrusted(repo)).toEqual({ trusted: true, root: repo });
    expect(isFolderTrusted(sub)).toEqual({ trusted: true, root: repo });
    expect(isFolderTrusted(sibling).trusted).toBe(false);
    expect(isFolderTrusted(join(root, "m")).trusted).toBe(false);
  });

  it("stores realpaths, so a symlinked cwd matches either way", () => {
    const real = dir("s", "real");
    const link = join(root, "s", "link");
    symlinkSync(real, link);
    trustFolder(link);
    expect(readTrustedFolders().map((f) => f.path)).toEqual([real]);
    expect(isFolderTrusted(link).trusted).toBe(true);
    expect(isFolderTrusted(real).trusted).toBe(true);
  });

  it("refuses a missing path, a file and the root; stores 0600; is idempotent", () => {
    expect(() => trustFolder(join(root, "nope"))).toThrow(/does not exist/);
    writeFileSync(join(dir("f"), "file"), "");
    expect(() => trustFolder(join(root, "f", "file"))).toThrow(/Not a directory/);
    expect(() => trustFolder("/")).toThrow(/root/);
    const d = dir("idem");
    trustFolder(d);
    trustFolder(d);
    expect(readTrustedFolders()).toHaveLength(1);
    expect(statSync(TRUSTED_FOLDERS_FILE).mode & 0o777).toBe(0o600);
  });

  it("untrusts by realpath, and by literal path once the folder is gone", () => {
    const d = dir("gone");
    trustFolder(d);
    expect(untrustFolder(d)).toBe(true);
    expect(untrustFolder(d)).toBe(false);
    trustFolder(d);
    rmSync(d, { recursive: true });
    expect(untrustFolder(d)).toBe(true);
    expect(readTrustedFolders()).toEqual([]);
  });

  it("a missing or corrupt store trusts nothing", () => {
    const d = dir("corrupt");
    expect(isFolderTrusted(d).trusted).toBe(false);
    writeFileSync(TRUSTED_FOLDERS_FILE, "{not json");
    expect(isFolderTrusted(d).trusted).toBe(false);
    writeFileSync(TRUSTED_FOLDERS_FILE, JSON.stringify({ folders: [{ path: 3 }, { path: "relative" }] }));
    expect(readTrustedFolders()).toEqual([]);
  });

  it("a missing cwd is untrusted, never an error", () => {
    trustFolder(dir("x"));
    expect(isFolderTrusted(join(root, "x-missing"))).toEqual({ trusted: false });
  });

  describe("worktrees", () => {
    const main = dir("wt", "main");
    git(main, "init", "-q");
    git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const wt = join(root, "wt", "linked");
    git(main, "worktree", "add", "-q", wt);

    it("a verified linked worktree (and its subdirectories) of a trusted repo is trusted", () => {
      trustFolder(main);
      expect(isFolderTrusted(wt)).toEqual({ trusted: true, root: main });
      expect(isFolderTrusted(dir("wt", "linked", "deep")).trusted).toBe(true);
    });

    it("a worktree of an untrusted repo is not", () => {
      trustFolder(dir("wt", "unrelated"));
      expect(isFolderTrusted(wt).trusted).toBe(false);
    });

    it("a forged .git file pointing into a trusted repo's worktrees/ without a matching back-pointer is untrusted", () => {
      trustFolder(main);
      const hostile = dir("wt", "hostile");
      // Points at the real worktree's admin dir, whose gitdir names `linked`, not `hostile`.
      writeFileSync(join(hostile, ".git"), `gitdir: ${join(main, ".git", "worktrees", "linked")}\n`);
      expect(isFolderTrusted(hostile).trusted).toBe(false);
      // And at an admin dir that doesn't exist.
      const hostile2 = dir("wt", "hostile2");
      mkdirSync(join(main, ".git", "worktrees", "fake"), { recursive: true });
      writeFileSync(join(hostile2, ".git"), `gitdir: ${join(main, ".git", "worktrees", "fake")}\n`);
      expect(isFolderTrusted(hostile2).trusted).toBe(false);
    });
  });
});

describe("scanRepoExecutableConfig", () => {
  it("reports hooks, statusLine, helpers and .mcp.json servers (cwd and parents)", () => {
    const parent = dir("scan", "parent");
    const cwd = dir("scan", "parent", "repo");
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [] }], PreToolUse: [] }, statusLine: { type: "command", command: "x" }, apiKeyHelper: "x" }),
    );
    writeFileSync(
      join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [] }] }, awsAuthRefresh: "y", gcpAuthRefresh: "" }),
    );
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { here: {} } }));
    writeFileSync(join(parent, ".mcp.json"), JSON.stringify({ mcpServers: { above: {} } }));
    expect(scanRepoExecutableConfig(cwd)).toEqual({
      hookEvents: ["SessionStart", "UserPromptSubmit"],
      statusLine: true,
      helpers: ["apiKeyHelper", "awsAuthRefresh"],
      mcpJsonServers: ["above", "here"],
    });
  });

  it("tolerates missing, malformed and oddly shaped files", () => {
    const cwd = dir("scan", "bad");
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), "{oops");
    writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify([1, 2]));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: ["x"] }));
    expect(scanRepoExecutableConfig(cwd)).toEqual({ hookEvents: [], statusLine: false, helpers: [], mcpJsonServers: [] });
    expect(scanRepoExecutableConfig(join(root, "scan", "missing")).hookEvents).toEqual([]);
  });
});

describe("repoLockdownSettings", () => {
  const home = dir("home");
  const cfg = dir("home", ".claude");

  it("disables hooks and every helper with strings, never null or undefined", () => {
    const s = repoLockdownSettings(dir("lock", "empty"), { HOME: join(root, "no-home") });
    expect(s).toEqual({
      disableAllHooks: true,
      apiKeyHelper: "",
      awsCredentialExport: "",
      awsAuthRefresh: "",
      gcpAuthRefresh: "",
      otelHeadersHelper: "",
      proxyAuthHelper: "",
    });
    for (const v of Object.values(s)) expect(v === null || v === undefined).toBe(false);
  });

  it("keeps the user tier's helpers (CLAUDE_CONFIG_DIR, else HOME/.claude)", () => {
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ apiKeyHelper: "user-helper", awsAuthRefresh: 5 }));
    expect(repoLockdownSettings(dir("lock", "a"), { HOME: home })).toMatchObject({ apiKeyHelper: "user-helper", awsAuthRefresh: "" });
    expect(repoLockdownSettings(dir("lock", "a"), { HOME: "/nowhere", CLAUDE_CONFIG_DIR: cfg }).apiKeyHelper).toBe("user-helper");
  });

  it("names every .mcp.json server, and omits the key when there are none", () => {
    const cwd = dir("lock", "mcp");
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { evil: {}, other: {} } }));
    expect(repoLockdownSettings(cwd, { HOME: "/nowhere" }).disabledMcpjsonServers).toEqual(["evil", "other"]);
    expect("disabledMcpjsonServers" in repoLockdownSettings(dir("lock", "nomcp"), { HOME: "/nowhere" })).toBe(false);
  });
});
