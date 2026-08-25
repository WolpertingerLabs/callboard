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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  // Typed as the intersection rather than `any`: the callback form is never
  // called (it throws), but `promisify.custom` has to be assignable onto it.
  const execFile = (() => {
    throw new Error("callback-style execFile is not used by the module under test");
  }) as (() => never) & {
    [promisify.custom]: (file: string) => Promise<{ stdout: string; stderr: string }>;
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

const { BINARY_VERSION_TTL_MS, binaryVersion, binaryVersionLine, resetBinaryVersionCache } = await import("./binary-version.js");

const A = "/fake/a/claude";
const B = "/fake/b/claude";

beforeEach(() => {
  pending.length = 0;
  hold = false;
  stdout = "2.0.1 (Claude Code)";
  vi.clearAllMocks();
  resetBinaryVersionCache();
});

afterEach(() => {
  vi.useRealTimers();
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

  it("reads only the first line, so a leading warning is not mined for a version", async () => {
    // The one mutation the rest of this suite could not kill: dropping the
    // `split("\n")[0]` passes every single-line fixture. It is not cosmetic —
    // a wrapper that prints a deprecation notice before delegating has no
    // version on line one, and scanning the whole blob would find the delegate's
    // and report it as the wrapper's. `claude-binary.ts`'s `looksLikeClaudeCode`
    // is a `binaryVersion(...) !== undefined` check, so that difference decides
    // whether a well-known-path candidate is accepted as runnable.
    stdout = "Node 18 is deprecated\n2.0.1 (Claude Code)";
    expect(await binaryVersionLine(A)).toBe("Node 18 is deprecated");
    expect(await binaryVersion(A)).toBeUndefined();
  });

  it("ignores anything printed after the first line", async () => {
    // The other direction, so neither a passing first line nor a failing one is
    // an accident of where the version happened to sit in the output.
    stdout = "2.0.1 (Claude Code)\nRun `claude doctor` for diagnostics";
    expect(await binaryVersionLine(A)).toBe("2.0.1 (Claude Code)");
    expect(await binaryVersion(A)).toBe("2.0.1");
  });

  it("strips the carriage return a CRLF binary leaves on the first line", async () => {
    // `trim()` on the whole blob only reaches the ends; the `\r` is interior.
    // Left in, it would ride along into `claudeCliVersion` and be rendered.
    stdout = "2.0.1 (Claude Code)\r\nsecond line\r\n";
    expect(await binaryVersionLine(A)).toBe("2.0.1 (Claude Code)");
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

/**
 * The TTL, and the property that makes it affordable.
 *
 * Caching for the process lifetime was wrong in one specific way: Claude Code
 * upgrades itself *in place*, so a new version arrives under an unchanged cache
 * key and Settings → About kept asserting the old one until the daemon
 * restarted. The fix cannot be "drop the cache" and it cannot be a plain TTL
 * either — the endpoint reading this is polled, and a plain TTL simply moves the
 * ~108ms spawn onto whichever request crosses the line. So: serve stale, probe
 * behind it, and every case here is about one half of that sentence.
 *
 * Fake timers rather than a shortened TTL, so the constant under test is the
 * exported one and not a test-only value that could drift away from it.
 */
describe("staleness", () => {
  /** Let a fire-and-forget revalidation run to completion. Microtasks only — no timers involved. */
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it("does not re-probe while the entry is inside the TTL", async () => {
    vi.useFakeTimers();
    expect(await binaryVersionLine(A)).toBe("2.0.1 (Claude Code)");

    vi.advanceTimersByTime(BINARY_VERSION_TTL_MS - 1);
    stdout = "2.1.0 (Claude Code)";
    expect(await binaryVersionLine(A)).toBe("2.0.1 (Claude Code)");
    await flush();
    expect(mocks.spawns).toHaveBeenCalledTimes(1);
  });

  it("serves the stale answer and converges on the next read once the TTL lapses", async () => {
    vi.useFakeTimers();
    expect(await binaryVersionLine(A)).toBe("2.0.1 (Claude Code)");

    // The user runs `npm i -g @anthropic-ai/claude-code@latest`, or the CLI
    // updates itself. Same path, new version — the case a path-keyed cache
    // cannot see on its own.
    vi.advanceTimersByTime(BINARY_VERSION_TTL_MS);
    stdout = "2.1.0 (Claude Code)";

    // This caller still gets the old answer, because making it wait is the one
    // thing the cache exists to prevent.
    expect(await binaryVersionLine(A)).toBe("2.0.1 (Claude Code)");
    expect(mocks.spawns).toHaveBeenCalledTimes(2);

    // …and the re-probe it triggered lands for whoever comes next.
    await flush();
    expect(await binaryVersionLine(A)).toBe("2.1.0 (Claude Code)");
  });

  it("returns immediately even when the revalidation hangs", async () => {
    // The property the whole design turns on. A slow `--version` — the exact
    // thing that made this endpoint 108ms — must cost a stale reader nothing.
    vi.useFakeTimers();
    await binaryVersionLine(A);
    vi.advanceTimersByTime(BINARY_VERSION_TTL_MS);

    hold = true;
    expect(await binaryVersionLine(A)).toBe("2.0.1 (Claude Code)");
    // Still outstanding: the answer above did not come from it.
    expect(pending).toHaveLength(2);
  });

  it("shares one revalidation between every stale reader", async () => {
    // Several pages poll this endpoint. A TTL lapse must not mean one child
    // process per reader that happens to arrive in the same window.
    vi.useFakeTimers();
    await binaryVersionLine(A);
    vi.advanceTimersByTime(BINARY_VERSION_TTL_MS);

    hold = true;
    await Promise.all([binaryVersionLine(A), binaryVersionLine(A), binaryVersionLine(A)]);
    expect(mocks.spawns).toHaveBeenCalledTimes(2);
  });

  it("restarts the TTL from when the revalidation settled, not from when it started", async () => {
    vi.useFakeTimers();
    await binaryVersionLine(A);
    vi.advanceTimersByTime(BINARY_VERSION_TTL_MS);
    await binaryVersionLine(A); // triggers revalidation #2
    await flush();

    // A fresh entry, so nothing here should spawn again.
    vi.advanceTimersByTime(BINARY_VERSION_TTL_MS - 1);
    await binaryVersionLine(A);
    await flush();
    expect(mocks.spawns).toHaveBeenCalledTimes(2);
  });

  it("does not let a revalidation started before a reset write its answer afterwards", async () => {
    // The generation hazard again, on the background path — which is where it is
    // most likely to bite, because nobody is awaiting the probe that loses. A
    // Recheck pressed while a revalidation is in flight must win.
    vi.useFakeTimers();
    await binaryVersionLine(A);
    vi.advanceTimersByTime(BINARY_VERSION_TTL_MS);

    hold = true;
    await binaryVersionLine(A); // starts revalidation, returns stale
    expect(pending).toHaveLength(2);

    resetBinaryVersionCache();
    hold = false;
    stdout = "3.0.0-after-recheck";
    expect(await binaryVersionLine(A)).toBe("3.0.0-after-recheck");

    // The abandoned revalidation finally answers with what it saw before the
    // reset. It must not overwrite the post-Recheck value, and it must not
    // delete the replacement's map entry on its way out.
    pending[1].resolve("2.0.1-stale");
    await flush();
    expect(await binaryVersionLine(A)).toBe("3.0.0-after-recheck");
    expect(mocks.spawns).toHaveBeenCalledTimes(3);
  });
});
