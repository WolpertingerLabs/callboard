// @vitest-environment jsdom
/**
 * The detector end to end, driven by the poll it actually rides on.
 *
 * `buildIdentity.test.ts` proves the rules; this proves the provider applies
 * them to real responses — including two things a pure reducer test cannot see:
 * that the client echoes its baseline back in `b` (which is what keeps the
 * steady-state response at ~40 bytes), and that a tab suspend does **not**
 * discard the baseline. The second one is the whole scenario: close the laptop,
 * upgrade, open the laptop. If `handleResume` cleared the build watch the way
 * it clears the version counters, the daemon's new id would arrive looking like
 * a first observation and be swallowed in silence.
 *
 * Time is faked so a "next poll" is a deliberate act rather than a wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
const V1 = "1.0.0-alpha.49+gaaaaaaaaaaaa";
const V2 = "1.0.0-alpha.50+gbbbbbbbbbbbb";

// Under vitest there is no Vite `define`, so the bundle's own id is the dev
// sentinel — which suppresses the prompt entirely and would make every
// assertion below pass for the wrong reason. Substituting a real id puts the
// provider on the production path. The rules themselves are untouched: the real
// `observeServerBuild` still runs.
vi.mock("../utils/buildIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/buildIdentity")>()),
  MY_BUILD_ID: "1.0.0-alpha.49+gaaaaaaaaaaaa",
}));

const { SessionProvider, useStaleBuildId } = await import("./SessionContext");

/**
 * A fake daemon. Answers the poll from `current`, and — like the real route —
 * only includes `build` when the client's `b` does not already match it.
 */
let current = V1;
let calls: URLSearchParams[] = [];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      calls.push(params);
      const body: Record<string, unknown> = { version: 1, metadataVersion: 1, sessions: {}, activeSummons: {} };
      if (params.get("b") !== current) body.build = current;
      return { ok: true, json: async () => body } as unknown as Response;
    }),
  );
}

function Probe() {
  const stale = useStaleBuildId();
  return <span data-testid="stale">{stale ?? "none"}</span>;
}

const staleText = () => screen.getByTestId("stale").textContent;

/** Let the in-flight poll's promise chain settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Advance to the next poll tick and settle it. */
async function nextPoll() {
  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  current = V1;
  calls = [];
  localStorage.clear();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  await settle();
}

describe("the first poll", () => {
  it("does not report the tab as stale when the daemon matches", async () => {
    await mount();
    expect(staleText()).toBe("none");
  });

  it("does not report the tab as stale when the daemon does not match either", async () => {
    // The one that has to hold. A daemon whose id differs from this bundle's on
    // the very first poll is not evidence of a stale tab — it is what a
    // frontend rebuilt without a daemon restart looks like, and prompting there
    // sends the user round a reload loop that cannot resolve.
    current = V2;
    await mount();
    expect(staleText()).toBe("none");
  });

  it("asks without a build id, since it has none to echo yet", async () => {
    await mount();
    expect(calls[0].has("b")).toBe(false);
  });
});

describe("steady state", () => {
  it("echoes the baseline back so the daemon can stay silent", async () => {
    await mount();
    await nextPoll();

    // Nothing to assert about `stale` here; the point is the request shape that
    // keeps the response tiny.
    expect(calls[calls.length - 1].get("b")).toBe(V1);
  });

  it("stays quiet across many polls of an unchanged daemon", async () => {
    await mount();
    for (let i = 0; i < 5; i++) await nextPoll();
    expect(staleText()).toBe("none");
  });
});

describe("the daemon moves", () => {
  it("reports the new build id", async () => {
    await mount();
    current = V2;
    await nextPoll();
    expect(staleText()).toBe(V2);
  });

  it("does not reload the page", async () => {
    // Belt and braces against the one behaviour that would lose a draft. The
    // provider has no business calling this, and now it cannot start to.
    const reload = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });

    await mount();
    current = V2;
    await nextPoll();
    await nextPoll();
    await nextPoll();

    expect(staleText()).toBe(V2);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("across a tab suspend", () => {
  it("still notices a daemon that moved while the tab was hidden", async () => {
    await mount();

    // The upgrade happens off-screen.
    current = V2;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();

    // `handleResume` drops the version counters to force full payloads. It must
    // not drop the build baseline with them, or this reads "none".
    expect(staleText()).toBe(V2);
  });
});
