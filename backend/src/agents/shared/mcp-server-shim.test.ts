/**
 * The shim's connect-retry loop, driven as a real child process.
 *
 * The regression this pins: a failed connect emits 'close' right after
 * 'error', and the shim used to exit 0 on any 'close' — so the retry the
 * 'error' handler had just scheduled never ran, and an agent that spawned the
 * shim a moment before the backend socket was listening got a dead MCP server
 * with a clean exit code.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHIM = join(dirname(fileURLToPath(import.meta.url)), "mcp-server-shim.ts");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function scratchSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cb-shim-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "s.sock");
}

function startShim(socketPath: string): { child: ChildProcess; exited: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  const child = spawn(process.execPath, ["--import", "tsx", SHIM, "--label=shim-test", socketPath], { stdio: "pipe" });
  cleanups.push(() => child.kill());
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.once("exit", (code) => resolve({ code, stdout, stderr })),
  );
  return { child, exited };
}

describe("mcp-server-shim connect retry", () => {
  it("keeps retrying until a late socket comes up, then relays and exits 0 when it closes", async () => {
    const socketPath = scratchSocketPath();
    const { child, exited } = startShim(socketPath);
    // Written before anything is listening — must be buffered, not lost.
    child.stdin!.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');

    // Well past the first attempt (and tsx's startup), so the shim has
    // certainly failed at least once before the socket exists.
    await new Promise((r) => setTimeout(r, 1500));
    expect(child.exitCode).toBeNull();

    const server = net.createServer((conn) => {
      conn.once("data", (chunk) => {
        // Echo, then hang up — the backend ending the session.
        conn.end(chunk);
      });
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
    cleanups.push(() => server.close());

    const result = await exited;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  }, 30_000);

  it("exits non-zero once retries are exhausted on a socket that never comes up", async () => {
    // ~100 attempts × 100ms: this one waits out the whole retry budget.
    const { exited } = startShim(scratchSocketPath());

    const result = await exited;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("shim-test: cannot connect to");
  }, 60_000);
});
