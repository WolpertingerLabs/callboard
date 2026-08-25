/**
 * The `--version` cache that `/api/system-info` now answers from.
 *
 * That endpoint is polled by several pages and used to spawn `claude --version`
 * on *every request* — measured at ~108ms of a ~120ms warm response, which the
 * New Chat picker's OpenCode button then queued behind. Caching it is only sound
 * if three things hold, and each has a case here:
 *
 * - the answer is reused rather than re-spawned (the point);
 * - it is keyed on the **resolved path**, so repointing the binary-override
 *   setting is not answered from the old binary's entry;
 * - a reset really re-probes, including when a probe from the previous
 *   generation is still in flight — the hazard `availability.ts` documents at
 *   length and this module now carries the same guard for.
 *
 * The spawn is mocked rather than run, because what is under test is the
 * bookkeeping around it: how many times it happened, and whose answer won.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** One call per real spawn. The queue below decides when each one answers. */
  spawns: vi.fn<(file: string) => void>(),
}));

/** Probes waiting to be answered, in the order they were started. */
const pending: { resolve: (stdout: string) => void; reject: (err: Error) => void }[] = [];

/** When false (the default) probes settle immediately, so no other case has to care. */
let hold = false;

/** What an immediately-settling probe prints. */
let stdout = "2.0.1 (Claude Code)";

// `promisify.custom` is mandatory: `binary-version.ts` captures
// `promisify(execFile)` at module load, and without the custom hook promisify
// falls back to the callback convention and resolves with a bare string — which
// the `{ stdout }` destructuring there would read as `undefined`.
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const execFile: any = () => {
    throw new Error("callback-style execFile is not used by the module under test");
  };
  execFile[promisify.custom] = (file: string) => {
    mocks.spawns(file);
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const entry = { resolve: (out: string) => resolve({ stdout: out, stderr: "" }), reject };
      pending.push(entry);
      if (!hold) entry.resolve(stdout);
    });
  };
  return { ...(await importOriginal<typeof import("node:child_process")>()), execFile };
});

const { binaryVersion, binaryVersionLine, resetBinaryVersionCache } = await import("./binary-version.js");

const A = "/fake/a/claude";
const B = "/fake/b/claude";

beforeEach(() => {
  pending.length = 0;
  hold = false;
  stdout = "2.0.1 (Claude Code)";
  vi.clearAllMocks();
  resetBinaryVersionCache();
});

describe("binaryVersionLine", () => {
  it("spawns once per path and serves every later caller from the cache", async () => {
    expect(await binaryVersionLine(A)).toBe("2.0.1 (Claude Code)");

    // The binary now reports something else. A cached answer must not notice —
    // otherwise the cache is not doing the thing the endpoint depends on.
    stdout = "9.9.9 (Claude Code)";
    expect(await binaryVersionLine(A)).toBe("2.0.1 (Claude Code)");
    expect(mocks.spawns).toHaveBeenCalledTimes(1);
  });

  it("keys on the path, so a different binary is a different answer", async () => {
    // The binary-override setting is the reason this matters: a user who
    // repoints it at another `claude` must not be handed the old one's version.
    expect(await binaryVersionLine(A)).toBe("2.0.1 (Claude Code)");
    stdout = "3.0.0 (Claude Code)";
    expect(await binaryVersionLine(B)).toBe("3.0.0 (Claude Code)");
    expect(mocks.spawns).toHaveBeenCalledTimes(2);
  });

  it("shares one spawn between concurrent callers rather than racing several", async () => {
    // The shape `/api/system-info` actually produces: several pages poll it, so
    // two requests landing in one tick must not become two child processes.
    hold = true;
    const first = binaryVersionLine(A);
    const second = binaryVersionLine(A);
    expect(mocks.spawns).toHaveBeenCalledTimes(1);

    pending[0].resolve("2.0.1 (Claude Code)");
    expect(await first).toBe("2.0.1 (Claude Code)");
    expect(await second).toBe("2.0.1 (Claude Code)");
  });

  it("caches a binary that printed nothing usable, instead of re-spawning it forever", async () => {
    // A cached `undefined` is a real answer. Re-spawning because the answer was
    // "no version" is how a polled endpoint starts costing a process per poll.
    stdout = "";
    expect(await binaryVersionLine(A)).toBeUndefined();
    expect(await binaryVersionLine(A)).toBeUndefined();
    expect(mocks.spawns).toHaveBeenCalledTimes(1);
  });

  it("reports an unrunnable binary as no version rather than throwing", async () => {
    // ENOENT, wrong arch, killed at the deadline — `/api/system-info` degrades
    // to `"unknown"` for all of them and must never 500.
    hold = true;
    const probe = binaryVersionLine(A);
    pending[0].reject(new Error("spawn ENOENT"));
    expect(await probe).toBeUndefined();
  });

  it("re-probes after a reset, which is what makes the Recheck button honest", async () => {
    expect(await binaryVersionLine(A)).toBe("2.0.1 (Claude Code)");

    // The user upgrades their CLI and presses Recheck.
    stdout = "2.1.0 (Claude Code)";
    resetBinaryVersionCache();
    expect(await binaryVersionLine(A)).toBe("2.1.0 (Claude Code)");
    expect(mocks.spawns).toHaveBeenCalledTimes(2);
  });

  it("does not let a probe started before a reset write its answer afterwards", async () => {
    // The hazard `availability.ts` documents, in this module. Clearing the maps
    // cannot cancel a promise already in flight, and the ordering that loses is
    // the likely one — a slow probe is the usual reason someone pressed Recheck,
    // so the stale answer tends to settle last and would win for the rest of the
    // process's life. It would also delete the *replacement* probe's map entry
    // on its way out.
    hold = true;
    const stale = binaryVersionLine(A);
    expect(pending).toHaveLength(1);

    resetBinaryVersionCache();
    const fresh = binaryVersionLine(A);
    expect(pending).toHaveLength(2);

    // The post-reset probe answers first with the truth; the stale one lands after.
    pending[1].resolve("2.1.0-new");
    expect(await fresh).toBe("2.1.0-new");
    pending[0].resolve("2.0.1-stale");
    expect(await stale).toBe("2.0.1-stale");

    // The cache still holds the post-reset answer, and it is still *cached* —
    // a stale probe that deleted the replacement's map entry would show up here
    // as a third spawn rather than as a wrong value.
    expect(await binaryVersionLine(A)).toBe("2.1.0-new");
    expect(mocks.spawns).toHaveBeenCalledTimes(2);
  });
});

describe("binaryVersion", () => {
  it("extracts the comparable version from the banner", async () => {
    stdout = "2.0.1 (Claude Code)";
    expect(await binaryVersion(A)).toBe("2.0.1");
  });

  it("refuses a banner with no dotted numeric token", async () => {
    // A wrapper printing `my custom codex build` must not become the engine's
    // `version` — that is a permanent amber drift row and an `isNewerVersion`
    // comparison over NaN. See the module doc.
    stdout = "my custom codex build";
    expect(await binaryVersion(A)).toBeUndefined();
    // …while the caller that only *displays* the banner still gets it. The two
    // accessors are the whole reason the cache holds the raw line.
    expect(await binaryVersionLine(A)).toBe("my custom codex build");
  });

  it("shares one spawn with binaryVersionLine rather than probing twice", async () => {
    // The property that makes two accessors cheaper than two caches: the daemon
    // reports `claudeCliVersion` from the banner and the engine card compares
    // the number, and that is one child process, not two.
    expect(await binaryVersion(A)).toBe("2.0.1");
    expect(await binaryVersionLine(A)).toBe("2.0.1 (Claude Code)");
    expect(mocks.spawns).toHaveBeenCalledTimes(1);
  });
});
