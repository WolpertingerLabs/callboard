import { describe, it, expect, vi } from "vitest";
import { createRequestBudget, createSharedLookup, RateLimitedError, RATE_LIMITED } from "./artifactBudget";
import { ARTIFACT_BRIDGE_LIMITS } from "../api";

/**
 * The tab-wide pieces the artifact bridges share. The bridge-level behaviour
 * (the write/read windows, visibility storms, a 1 write/s writer) is in
 * artifactBridge.test.ts; this is the lookup's own contract.
 */

function lookup() {
  let now = 0;
  const gates: Array<{ resolve: (v: string) => void; reject: (e: Error) => void }> = [];
  const fetch = vi.fn(
    (_id: string) =>
      new Promise<string>((resolve, reject) => {
        gates.push({ resolve, reject });
      }),
  );
  const l = createSharedLookup(fetch, () => now);
  return { l, fetch, gates, tick: (ms: number) => (now += ms), at: (ms: number) => (now = ms) };
}

describe("request budget", () => {
  it(`starts full at ${ARTIFACT_BRIDGE_LIMITS.burst}, refills at ${ARTIFACT_BRIDGE_LIMITS.refillPerSecond}/s, never above the burst`, () => {
    let now = 0;
    const b = createRequestBudget(() => now);
    let n = 0;
    while (b.spend(1)) n++;
    expect(n).toBe(ARTIFACT_BRIDGE_LIMITS.burst);
    now += 4000;
    expect(b.spend(4 * ARTIFACT_BRIDGE_LIMITS.refillPerSecond)).toBe(true);
    expect(b.spend(1)).toBe(false);
    now += 3_600_000;
    n = 0;
    while (b.spend(1)) n++;
    expect(n).toBe(ARTIFACT_BRIDGE_LIMITS.burst);
  });
});

describe("shared lookup", () => {
  it("concurrent callers share one fetch in flight", async () => {
    const t = lookup();
    const a = t.l.get("x", 5000, null);
    const b = t.l.get("x", 2000, null);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    t.gates[0].resolve("v");
    expect(await Promise.all([a, b])).toEqual(["v", "v"]);
  });

  it("a result is reused while the fetch STARTED under maxAgeMs ago — however long it took to answer", async () => {
    const t = lookup();
    const first = t.l.get("x", 2000, null);
    t.tick(1500); // a slow answer: it lands 1.5 s after it was asked
    t.gates[0].resolve("v1");
    await first;
    t.tick(499);
    await t.l.get("x", 2000, null);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    t.tick(1); // 2000 ms since it started, though only 500 since it answered
    const again = t.l.get("x", 2000, null);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    t.gates[1].resolve("v2");
    expect(await again).toBe("v2");
    // A laxer caller (a read) still reuses the newest.
    expect(await t.l.get("x", 5000, null)).toBe("v2");
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it("keys are per artifact", () => {
    const t = lookup();
    void t.l.get("x", 5000, null);
    void t.l.get("y", 5000, null);
    expect(t.fetch.mock.calls.map((c) => c[0])).toEqual(["x", "y"]);
  });

  it("a failed fetch is never reused: its sharers see the failure, the next caller fetches again", async () => {
    const t = lookup();
    const a = t.l.get("x", 5000, null);
    const b = t.l.get("x", 5000, null);
    t.gates[0].reject(new Error("offline"));
    await expect(a).rejects.toThrow("offline");
    await expect(b).rejects.toThrow("offline");
    void t.l.get("x", 5000, null);
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it("only a real fetch spends the budget; over it, RateLimitedError and no fetch", async () => {
    const t = lookup();
    const spend = vi.fn(() => true);
    void t.l.get("x", 5000, { spend });
    void t.l.get("x", 5000, { spend });
    void t.l.get("x", 5000, { spend });
    expect(spend).toHaveBeenCalledTimes(1);
    t.tick(5000);
    const refused = t.l.get("x", 5000, { spend: () => false });
    await expect(refused).rejects.toBeInstanceOf(RateLimitedError);
    await expect(refused).rejects.toThrow(new RegExp(`^${RATE_LIMITED}`));
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("seed records an outside fetch (the renderer's pre-mount judgement) unless a newer one is already held", async () => {
    const t = lookup();
    t.at(1000);
    t.l.seed("x", 1000, "seeded");
    t.tick(1999);
    expect(await t.l.get("x", 2000, null)).toBe("seeded");
    t.l.seed("x", 500, "older");
    expect(await t.l.get("x", 5000, null)).toBe("seeded");
    expect(t.fetch).not.toHaveBeenCalled();
  });
});
