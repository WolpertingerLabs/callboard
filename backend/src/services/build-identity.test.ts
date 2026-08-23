/**
 * That the daemon reads its build id **once**.
 *
 * This is a performance property with a correctness-shaped hole under it, and
 * it is invisible to every other test: drop the memo and all of them still
 * pass, while the daemon starts doing a `readFileSync` per poll, per open tab,
 * per second — on the one route whose entire virtue is being cheap enough to
 * call at 1 Hz forever.
 *
 * The memo is also *why* the client compares the daemon's id against itself
 * over time rather than against its own compile-time id: a cached read means a
 * frontend rebuilt without a daemon restart leaves the daemon reporting a stale
 * id, which points the wrong way. The two decisions are one decision, so the
 * cache is documented and tested rather than treated as an optimisation
 * somebody may later "clean up".
 *
 * Reads are counted by wrapping the real `fs`, not by replacing it: the point
 * is how many times the file is touched, and only the genuine article can be
 * miscounted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let reads = 0;
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: actual,
    readFileSync: (p: unknown, ...rest: unknown[]) => {
      if (String(p).endsWith("build-id.json")) reads++;
      return (actual.readFileSync as any)(p, ...rest);
    },
  };
});

const { getServerBuildId, resetServerBuildIdCache } = await import("./build-identity.js");

beforeEach(() => {
  resetServerBuildIdCache();
  reads = 0;
});

describe("getServerBuildId", () => {
  it("touches the file once, however many times it is asked", () => {
    // Counted as *attempts*, so this holds whether or not this checkout has a
    // built frontend — a daemon with no dist must not retry every second either.
    for (let i = 0; i < 50; i++) getServerBuildId();
    expect(reads).toBe(1);
  });

  it("gives the same answer every time", () => {
    const first = getServerBuildId();
    for (let i = 0; i < 5; i++) expect(getServerBuildId()).toBe(first);
    expect(typeof first).toBe("string");
    expect(first.length).toBeGreaterThan(0);
  });

  it("reads again only after the cache is dropped", () => {
    getServerBuildId();
    getServerBuildId();
    expect(reads).toBe(1);

    resetServerBuildIdCache();
    getServerBuildId();
    expect(reads).toBe(2);
  });
});
