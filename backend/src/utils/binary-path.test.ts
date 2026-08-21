/**
 * `utils/binary-path.ts` — the check both engine resolvers and both settings
 * fields run through.
 *
 * Real files in a real temp directory rather than a mocked `fs`, and
 * deliberately so: the thing under test is a permission bit, and a mock that
 * returns whatever the test author expected `accessSync` to do would pass while
 * the resolver kept handing the SDK a path it cannot spawn. That is the exact
 * shape of the bug this module was written to close — `existsSync` alone
 * accepted a directory and accepted a non-executable file, and every chat then
 * died at the first turn against a path Settings reported as configured.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBinaryPath, checkBinaryPathAsync } from "./binary-path.js";

let scratch: string;

const check = (path: string | undefined) => checkBinaryPath(path, "Codex binary", "Falling back to the bundled binary.");

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cb-binary-path-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("blank is the default, not a failure", () => {
  it.each([undefined, "", "   "])("reports state null for %p", (value) => {
    const result = check(value);
    expect(result.state).toBeNull();
    expect(result.path).toBe("");
    // Empty rather than a sentence: a settings field that nags about being
    // empty is nagging about the default.
    expect(result.detail).toBe("");
  });
});

describe("an executable file is what runs", () => {
  it("accepts a file with the execute bit set", () => {
    const bin = join(scratch, "codex");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);

    const result = check(bin);
    expect(result.state).toBe("active");
    expect(result.path).toBe(bin);
    expect(result.detail).toContain("executable");
  });

  it("trims surrounding whitespace, because a pasted path carries it", () => {
    const bin = join(scratch, "codex");
    writeFileSync(bin, "");
    chmodSync(bin, 0o755);

    expect(check(`  ${bin}\n`)).toMatchObject({ state: "active", path: bin });
  });

  it("follows a symlink to an executable — every npm global bin is one", () => {
    const target = join(scratch, "real");
    const link = join(scratch, "linked");
    writeFileSync(target, "");
    chmodSync(target, 0o755);
    symlinkSync(target, link);

    expect(check(link).state).toBe("active");
  });

  it("reports a broken symlink as missing rather than throwing", () => {
    const link = join(scratch, "dangling");
    symlinkSync(join(scratch, "never-existed"), link);

    expect(check(link).state).toBe("missing");
  });
});

describe("a relative path is rejected before anything is looked at", () => {
  it("refuses one even when it resolves against the daemon's own cwd", () => {
    // The worst of the four, because it is not a stricter test but a different
    // question: Callboard resolves it against the daemon's working directory
    // while the engine spawns it with the *chat folder* as cwd. `"relwrap"`
    // therefore validated green — the daemon's cwd had it — and failed to
    // launch in every chat. So the check must not be "can I find it from here".
    const bin = join(scratch, "relwrap");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);

    const previousCwd = process.cwd();
    try {
      process.chdir(scratch);
      // Present, executable, and findable from right here — and still refused.
      expect(check("relwrap").state).toBe("not-absolute");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it.each(["relwrap", "./bin/codex", "../codex", "bin/codex"])("refuses %p", (value) => {
    const result = check(value);
    expect(result.state).toBe("not-absolute");
    expect(result.detail).toContain("relative path");
    // Says what happens instead, like every other rejection.
    expect(result.detail).toContain("Falling back to the bundled binary.");
  });

  it("does not touch the filesystem to decide — a relative path has no right answer there", () => {
    // `~/codex` is the other one users type. It is not absolute to Node (no
    // tilde expansion outside a shell), so it is refused for the same reason
    // rather than silently resolving to a directory named `~`.
    expect(check("~/codex").state).toBe("not-absolute");
  });
});

describe("the three rejections, which fail differently and are fixed differently", () => {
  it("missing — nothing at the path", () => {
    const result = check(join(scratch, "nope"));
    expect(result.state).toBe("missing");
    // Every rejection says what happens instead. "This path is bad" without
    // "and so this runs" is half an answer.
    expect(result.detail).toContain("Falling back to the bundled binary.");
  });

  it("not-a-file — a directory, which `existsSync` alone happily accepted", () => {
    const dir = join(scratch, "a-dir");
    mkdirSync(dir);

    const result = check(dir);
    expect(result.state).toBe("not-a-file");
    expect(result.detail).toContain("directory");
  });

  it("not-executable — a real file with no execute bit, and it names the fix", () => {
    const bin = join(scratch, "downloaded");
    writeFileSync(bin, "binary contents");
    chmodSync(bin, 0o644);

    const result = check(bin);
    expect(result.state).toBe("not-executable");
    expect(result.detail).toContain("EACCES");
    expect(result.detail).toContain(`chmod +x ${bin}`);
  });

  it("re-checks after a chmod rather than caching the first answer", () => {
    // The field is edited while the user fixes the problem, so a cached "no"
    // would mean the only way to clear the error was a daemon restart —
    // which is the papercut this whole phase exists to remove.
    const bin = join(scratch, "fixable");
    writeFileSync(bin, "");
    chmodSync(bin, 0o644);
    expect(check(bin).state).toBe("not-executable");

    chmodSync(bin, 0o755);
    expect(check(bin).state).toBe("active");
  });
});

describe("the chmod suggestion is checked, not assumed", () => {
  it("names `chmod +x` for a file this user owns", () => {
    const bin = join(scratch, "mine");
    writeFileSync(bin, "");
    chmodSync(bin, 0o644);
    expect(check(bin).detail).toContain(`chmod +x ${bin}`);
  });

  it("does not tell the user to chmod a file belonging to someone else", () => {
    // Unconditional advice here has the settings page cheerfully suggest
    // `chmod +x /etc/passwd` — a command that will not work and should not be
    // recommended. Ownership is observable, so it is observed.
    const result = check("/etc/passwd");
    // Skip where the check is meaningless: running as root, or a system without
    // that file. The assertion is about advice, not about /etc/passwd.
    if (result.state !== "not-executable") return;
    expect(result.detail).not.toContain("chmod +x");
    expect(result.detail).toContain("another user");
  });
});

describe("the async variant answers identically", () => {
  it("agrees with the sync one on every state", async () => {
    // The route uses the async one so a debounced per-keystroke check does not
    // `statSync` on the event loop. Two implementations that could disagree
    // would be the same defect this module exists to prevent, one layer down.
    const good = join(scratch, "ok");
    writeFileSync(good, "");
    chmodSync(good, 0o755);
    const dir = join(scratch, "dir");
    mkdirSync(dir);
    const notExec = join(scratch, "plain");
    writeFileSync(notExec, "");
    chmodSync(notExec, 0o644);

    for (const value of [undefined, "", "relative/path", good, dir, notExec, join(scratch, "gone")]) {
      const sync = check(value);
      const async = await checkBinaryPathAsync(value, "Codex binary", "Falling back to the bundled binary.");
      expect(async).toEqual(sync);
    }
  });
});

describe("the naming arguments are prose, and reach the sentence", () => {
  it("names the engine and its fallback verbatim", () => {
    const result = checkBinaryPath(join(scratch, "gone"), "Claude Code binary", "Callboard falls back to a `claude` on its PATH.");
    expect(result.detail).toContain("Callboard falls back to a `claude` on its PATH.");

    const dir = join(scratch, "d");
    mkdirSync(dir);
    expect(checkBinaryPath(dir, "Claude Code binary", "…").detail).toContain("Claude Code binary");
  });
});
