/**
 * `resolveBinaryPath` — the cached, shell-free `which` in `utils/binary-path.ts`.
 *
 * Moved here from the retired ACP harness's `availability.ts`; Codex login
 * detection (`engine-status.ts`) is its consumer. `execFile` is mocked with a
 * deferred `which`, so the cache, the in-flight sharing and the reset-mid-probe
 * generation guard can be driven deterministically. The end-to-end wiring
 * (Recheck → Codex card) is in `services/engine-cache-invalidation.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** One deferred `which` per spawn; `answer(null)` means "not found" (non-zero exit). */
const spawns: { file: string; args: string[]; opts: Record<string, unknown>; answer: (path: string | null) => void }[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const execFile: any = () => {
    throw new Error("callback-style execFile is not used by binary-path.ts");
  };
  execFile[promisify.custom] = (file: string, args: string[], opts: Record<string, unknown>) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      spawns.push({
        file,
        args,
        opts,
        answer: (path) => (path === null ? reject(Object.assign(new Error("not found"), { code: 1 })) : resolve({ stdout: `${path}\n`, stderr: "" })),
      });
    });
  return { ...(await importOriginal<typeof import("node:child_process")>()), execFile };
});

const { resolveBinaryPath, resetBinaryPathCache } = await import("./binary-path.js");

/** Let the probe's `execFile` call register. */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetBinaryPathCache();
  spawns.length = 0;
});

describe("resolveBinaryPath", () => {
  it("runs `which` without a shell, with the command as an argument, bounded by a hard-kill timeout", async () => {
    const probe = resolveBinaryPath("codex");
    await tick();
    expect(spawns).toHaveLength(1);
    expect(spawns[0].file).toBe(process.platform === "win32" ? "where" : "which");
    expect(spawns[0].args).toEqual(["codex"]);
    expect(spawns[0].opts).toMatchObject({ timeout: 3_000, killSignal: "SIGKILL" });
    spawns[0].answer("/usr/local/bin/codex");
    expect(await probe).toBe("/usr/local/bin/codex");
  });

  it("caches the answer for the process lifetime", async () => {
    const first = resolveBinaryPath("codex");
    await tick();
    spawns[0].answer("/a/codex");
    expect(await first).toBe("/a/codex");
    expect(await resolveBinaryPath("codex")).toBe("/a/codex");
    expect(spawns).toHaveLength(1);
  });

  it("returns null on a miss, and caches the miss too", async () => {
    const first = resolveBinaryPath("nope");
    await tick();
    spawns[0].answer(null);
    expect(await first).toBeNull();
    expect(await resolveBinaryPath("nope")).toBeNull();
    expect(spawns).toHaveLength(1);
  });

  it("shares one in-flight spawn between concurrent callers", async () => {
    const a = resolveBinaryPath("codex");
    const b = resolveBinaryPath("codex");
    await tick();
    expect(spawns).toHaveLength(1);
    spawns[0].answer("/a/codex");
    expect(await a).toBe("/a/codex");
    expect(await b).toBe("/a/codex");
  });

  it("takes the first line when `where` lists several matches", async () => {
    const probe = resolveBinaryPath("codex");
    await tick();
    spawns[0].answer("/first/codex\n/second/codex");
    expect(await probe).toBe("/first/codex");
  });

  it("re-probes after a reset", async () => {
    const first = resolveBinaryPath("codex");
    await tick();
    spawns[0].answer(null);
    expect(await first).toBeNull();

    resetBinaryPathCache();
    const second = resolveBinaryPath("codex");
    await tick();
    expect(spawns).toHaveLength(2);
    spawns[1].answer("/b/codex");
    expect(await second).toBe("/b/codex");
  });

  it("does not let a probe started before a reset write its answer afterwards", async () => {
    // A reset cannot cancel a promise already in flight, and a slow probe is
    // the usual reason someone pressed Recheck — so the stale answer tends to
    // settle last. Without the generation guard it would win for the rest of
    // the process's life, and delete the replacement probe's map entry.
    const stale = resolveBinaryPath("codex");
    await tick();
    resetBinaryPathCache();
    const fresh = resolveBinaryPath("codex");
    await tick();
    expect(spawns).toHaveLength(2);

    spawns[1].answer("/new/codex");
    expect(await fresh).toBe("/new/codex");
    spawns[0].answer(null);
    expect(await stale).toBeNull();

    // Still the post-reset answer, served from cache with no third spawn.
    expect(await resolveBinaryPath("codex")).toBe("/new/codex");
    expect(spawns).toHaveLength(2);
  });
});
