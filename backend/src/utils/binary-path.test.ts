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
import { checkBinaryPath } from "./binary-path.js";

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

describe("the naming arguments are prose, and reach the sentence", () => {
  it("names the engine and its fallback verbatim", () => {
    const result = checkBinaryPath(join(scratch, "gone"), "Claude Code binary", "Callboard falls back to a `claude` on its PATH.");
    expect(result.detail).toContain("Callboard falls back to a `claude` on its PATH.");

    const dir = join(scratch, "d");
    mkdirSync(dir);
    expect(checkBinaryPath(dir, "Claude Code binary", "…").detail).toContain("Claude Code binary");
  });
});
