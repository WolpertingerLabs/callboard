import { describe, it, expect, vi } from "vitest";
import { createRequestBudget, createSharedLookup, createTabBudget, RateLimitedError, RATE_LIMITED } from "./artifactBudget";
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

/**
 * A tab's worth of accounts on one fake clock, stepped 1 ms at a time. Each
 * `actor` is asked at every step whether it wants a token now; a spinner says
 * yes until it is refused (and then again next millisecond), the way an
 * artifact that retries at once on error does.
 */
function simulate(seconds: number, actors: Array<{ group?: string; wants: (t: number) => number; recheckAt?: (t: number) => boolean; spin?: boolean }>) {
  let now = 0;
  const tab = createTabBudget(() => now);
  const accounts = actors.map((a) => tab.open(a.group));
  const got = actors.map(() => 0);
  const refused = actors.map(() => 0);
  const rechecks = actors.map(() => 0);
  let total = 0;
  const log: number[] = []; // time of every token spent, for the cap check
  for (now = 0; now < seconds * 1000; now++) {
    actors.forEach((a, i) => {
      if (a.spin) {
        while (accounts[i].spend(1)) {
          got[i]++;
          log.push(now);
        }
        refused[i]++;
        return;
      }
      // A re-check of the mount's artifact, shared by all its mounts, before the call that needed it.
      if (a.recheckAt?.(now)) {
        if (accounts[i].spend(1, true)) {
          rechecks[i]++;
          log.push(now);
        } else refused[i]++;
      }
      for (let n = a.wants(now); n > 0; n--) {
        if (accounts[i].spend(1)) {
          got[i]++;
          log.push(now);
        } else refused[i]++;
      }
    });
  }
  total = got.reduce((s, x) => s + x, 0) + rechecks.reduce((s, x) => s + x, 0);
  return { got, refused, rechecks, total, log };
}

/** Once every `ms`, starting at `from`. */
const every = (ms: number, from = 0) => (t: number) => (t >= from && (t - from) % ms === 0 ? 1 : 0);
const R = ARTIFACT_BRIDGE_LIMITS.refillPerSecond;

describe("tab budget — one tab-wide cap, divided fairly between the mounts using it", () => {
  it("one mount alone has the whole tab: a burst of 12, then 1 write/s with a re-check every other write (1.5/s) for 120 s, never refused", () => {
    const s = simulate(121, [{ wants: (t) => (t === 0 ? 12 : t % 1000 === 0 ? (t % 2000 === 0 ? 2 : 1) : 0) }]);
    expect(s.refused[0]).toBe(0);
    expect(s.got[0]).toBe(12 + 120 + 60);
  });

  it(`a spinner cannot take a paced neighbour's share: at 0.8/s (under half of ${R}/s) beside a spinner for 120 s, the paced mount is never refused`, () => {
    const s = simulate(120, [{ wants: every(1250) }, { spin: true, wants: () => 0 }]);
    expect(s.refused[0]).toBe(0);
    expect(s.got[0]).toBe(96);
    // The spinner has the rest — the tab still spends its whole rate, no more.
    expect(s.got[1]).toBeGreaterThan(R * 120 - 96 - 2);
    expect(s.total).toBeLessThanOrEqual(ARTIFACT_BRIDGE_LIMITS.burst + R * 120);
  });

  it("…nor three spinners: a mount at a quarter of the rate beside them is never refused", () => {
    const spin = { spin: true, wants: () => 0 };
    const s = simulate(120, [{ wants: every(2400) }, spin, spin, spin]);
    expect(s.refused[0]).toBe(0);
    expect(s.got[0]).toBe(50);
    // …and the spinners split what is left evenly between them — bar the full tab the first of them found unclaimed at t=0.
    const [, a, b, c] = s.got;
    expect(Math.max(a, b, c) - Math.min(a, b, c)).toBeLessThanOrEqual(ARTIFACT_BRIDGE_LIMITS.burst + 2);
    expect(Math.max(b, c) - Math.min(b, c)).toBeLessThanOrEqual(2);
  });

  it(`what no fair split can do: a mount wanting 1.5/s beside a spinner gets its half (${R / 2}/s), not 1.5`, () => {
    const s = simulate(120, [{ wants: (t) => (t >= 1000 && t % 1000 === 0 ? (t % 2000 === 0 ? 2 : 1) : 0) }, { spin: true, wants: () => 0 }]);
    const rate = s.got[0] / 119;
    expect(rate).toBeGreaterThan((R / 2) * 0.97);
    expect(rate).toBeLessThan((R / 2) * 1.05);
  });

  it("four equal pollers at 1/s (together over the rate) each get a quarter, within 3%", () => {
    const s = simulate(300, [0, 250, 500, 750].map((phase) => ({ wants: every(1000, phase) })));
    const mean = s.total / 4;
    for (const g of s.got) expect(Math.abs(g - mean) / mean).toBeLessThan(0.03);
    expect(mean / 300).toBeCloseTo(R / 4, 1);
  });

  it("a light mount gets all it asks and its unused share goes to the busy one, not to waste", () => {
    const s = simulate(120, [{ wants: every(5000) }, { wants: every(700) }]);
    expect(s.refused[0]).toBe(0);
    // 1/0.7 s ≈ 1.43/s wanted, 1.75 − 0.2 available.
    expect(s.refused[1]).toBe(0);
  });

  it("a mount that has stopped asking stops counting: the one still asking gets the whole rate back", () => {
    const s = simulate(60, [{ wants: (t) => (t < 10_000 ? every(500)(t) : 0) }, { wants: (t) => (t % 1000 === 0 ? 2 : 0) }]);
    // After the first stopped (plus the window it is still counted for), 2/s against 1.75/s: all but the overshoot.
    const late = s.log.filter((t) => t >= 10_000 + ARTIFACT_BRIDGE_LIMITS.activeWindowMs + 1000).length;
    expect(late / (60 - 16)).toBeGreaterThan(R * 0.95);
  });

  it(`never more than the tab-wide cap, however many mounts: in any window w, ≤ ${ARTIFACT_BRIDGE_LIMITS.burst} + ${R}·w`, () => {
    const s = simulate(90, [
      { spin: true, wants: () => 0 },
      { wants: every(300) },
      { wants: (t) => (t % 7000 < 500 ? 1 : 0) },
      { wants: every(1000, 400), group: "g", recheckAt: (t) => t % 5000 === 400 },
      { wants: every(1000, 900), group: "g" },
      { spin: true, wants: () => 0 },
    ]);
    const log = s.log;
    let j = 0;
    for (let i = 0; i < log.length; i++) {
      while (log[j] < log[i] - 30_000) j++;
      // tokens spent in (log[i] − 30 s, log[i]]
      expect(i - j + 1).toBeLessThanOrEqual(ARTIFACT_BRIDGE_LIMITS.burst + R * 30 + 1e-6);
    }
    expect(s.total).toBeLessThanOrEqual(ARTIFACT_BRIDGE_LIMITS.burst + R * 90 + 1e-6);
  });

  it("a shared cost (an artifact's re-check) is split between that artifact's mounts, not charged to whoever asked first", () => {
    let now = 0;
    const tab = createTabBudget(() => now);
    const [a, b, c, other] = [tab.open("art"), tab.open("art"), tab.open("art"), tab.open("else")];
    while (a.spend(1)); // nothing left unclaimed
    // All four in use (asking, though for nothing), each holding the share it has been given.
    for (now = 0; now <= 20_000; now += 1000) for (const x of [a, b, c, other]) x.spend(0);
    now = 20_000;
    const before = [a, b, c, other].map((x) => x.available());
    expect(a.spend(1, true)).toBe(true);
    const after = [a, b, c, other].map((x) => x.available());
    const paid = before.map((v, i) => v - after[i]);
    // a, b and c each pay a third; the other artifact's mount pays nothing.
    for (const p of paid.slice(0, 3)) expect(p).toBeCloseTo(1 / 3, 6);
    expect(paid[3]).toBe(0);
  });

  it("four bubbles of one polling artifact stay equal though the same one always triggers its re-check", () => {
    // Poller 0 fires first in every period, so it is always the one whose read finds the check stale.
    const s = simulate(300, [0, 250, 500, 750].map((phase, i) => ({ group: "poll", wants: every(1000, phase), recheckAt: (t: number) => i === 0 && t % 5000 === 0 })));
    expect(s.rechecks[0]).toBeGreaterThan(40);
    expect(s.rechecks.slice(1)).toEqual([0, 0, 0]);
    // Reads, not tokens: poller 0 paid for every check, and was paid back by the others.
    const mean = s.got.reduce((x, y) => x + y, 0) / 4;
    for (const g of s.got) expect(Math.abs(g - mean) / mean).toBeLessThan(0.05);
  });

  it("a mount that goes quiet hands its tokens back: four that filled their shares and stopped do not freeze the tab for a spinner", () => {
    let now = 0;
    const tab = createTabBudget(() => now);
    const quiet = [tab.open(), tab.open(), tab.open(), tab.open()];
    while (quiet[0].spend(1)); // nothing unclaimed
    // All four asking (for nothing) until each holds its full share: the whole burst, between them.
    for (; now <= 30_000; now += 500) for (const q of quiet) q.spend(0);
    expect(quiet.reduce((sum, q) => sum + q.available(), 0) / 4).toBeCloseTo(ARTIFACT_BRIDGE_LIMITS.shareBurst, 6);
    // Then silent. Kept, their shares would fill the tab's burst for good and every refill would be thrown away.
    const spinner = tab.open();
    let got = 0;
    for (; now <= 90_000; now++) while (spinner.spend(1)) got++;
    // Nothing until their window runs out (at 35 s); then the burst they held, and the full rate for 55 s.
    expect(got).toBeGreaterThanOrEqual(ARTIFACT_BRIDGE_LIMITS.burst + Math.floor(R * 55) - 2);
  });

  it("closing a mount hands its tokens back to the tab", () => {
    let now = 0;
    const tab = createTabBudget(() => now);
    const a = tab.open();
    while (a.spend(1));
    // a keeps asking (for nothing), so it stays in use and its share fills to its own cap.
    for (now = 0; now <= 60_000; now += 1000) a.spend(0);
    now = 60_000;
    expect(a.available()).toBe(ARTIFACT_BRIDGE_LIMITS.burst); // its share plus the tab's unclaimed rest
    const b = tab.open();
    a.close();
    let n = 0;
    while (b.spend(1)) n++;
    expect(n).toBe(ARTIFACT_BRIDGE_LIMITS.burst);
  });

  it("after a refusal, retryAfterMs says when this mount's share will next hold a token — and it does", () => {
    let now = 0;
    const tab = createTabBudget(() => now);
    const a = tab.open();
    const b = tab.open();
    while (a.spend(1));
    expect(b.spend(1)).toBe(false);
    const wait = b.retryAfterMs(1);
    // Two mounts asking: b's share is half the rate.
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(Math.ceil(1000 / (R / 2)) + 1);
    now += wait - 100;
    expect(b.spend(1)).toBe(false);
    now += 100;
    expect(b.spend(1)).toBe(true);
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
    const retryAfterMs = () => 700;
    void t.l.get("x", 5000, { spend, retryAfterMs, available: () => 1 });
    void t.l.get("x", 5000, { spend, retryAfterMs, available: () => 1 });
    void t.l.get("x", 5000, { spend, retryAfterMs, available: () => 1 });
    expect(spend).toHaveBeenCalledTimes(1);
    // Billed as a shared cost: the check serves every mount of the artifact.
    expect(spend).toHaveBeenCalledWith(1, true);
    t.tick(5000);
    const refused = t.l.get("x", 5000, { spend: () => false, retryAfterMs, available: () => 0 });
    await expect(refused).rejects.toBeInstanceOf(RateLimitedError);
    await expect(refused).rejects.toMatchObject({ retryAfterMs: 700 });
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
