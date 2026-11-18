/**
 * The New Chat popup's provider row: believed from the wire, not from cache.
 *
 * - **The refresh.** The effect asks the daemon again with `{refresh: true}`.
 *   `getSystemInfo()`'s cached default resolves with the last payload this tab
 *   saw and hands the revalidation to the module cache rather than to the
 *   caller, so taking the default pinned the panel to a stale answer for its
 *   entire lifetime — a button for an unavailable harness, rendered *enabled*,
 *   which `downgradeProvider` then agreed with.
 * - **No seed for the Codex gate.** The cached payload does seed some fields,
 *   but never `codexConfigured`: a cached `false` would disable a button that
 *   may well be fine, so until the daemon answers the button stays live.
 *
 * (This suite was first written around the retired ACP harness's OpenCode
 * button, the only provider button once built from server data; the Codex gate
 * is what is left of the same contract.)
 *
 * The real `../api` module is used with `fetch` stubbed, so the cache and the
 * component are exercised as the one mechanism they actually are — mocking
 * `getSystemInfo` would assert the component calls a function, which is not the
 * thing that broke.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NewChatPanel from "./NewChatPanel";
import { getSystemInfo, resetSystemInfoCache } from "../api";

const payload = (codexConfigured: boolean) => ({
  version: "1.0.0",
  codexConfigured,
});

/** Resolve `/system-info` with `body`; answer anything else the panel touches harmlessly. */
function serve(body: unknown) {
  return vi.fn((url: string) =>
    String(url).includes("/system-info") ? Promise.resolve({ ok: true, json: async () => body }) : Promise.resolve({ ok: true, json: async () => ({}) }),
  );
}

/**
 * A daemon that never answers.
 *
 * The load-bearing stub: with it in place, anything the panel renders came from
 * the synchronous seed and cannot have come from the effect, which is the exact
 * claim these cases make.
 */
function serveNothing() {
  return vi.fn((url: string) => (String(url).includes("/system-info") ? new Promise(() => {}) : Promise.resolve({ ok: true, json: async () => ({}) })));
}

const panel = () => (
  <MemoryRouter>
    <NewChatPanel onClose={() => {}} />
  </MemoryRouter>
);

beforeEach(() => {
  resetSystemInfoCache();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const codexButton = () => screen.getByRole("button", { name: "Codex" });

describe("the seed — what paints before the daemon answers", () => {
  it("does not disable Codex from a cached false while the daemon is silent", async () => {
    vi.stubGlobal("fetch", serve(payload(false)));
    await getSystemInfo();

    // From here on nothing resolves, so the effect cannot contribute.
    vi.stubGlobal("fetch", serveNothing());
    render(panel());

    expect(codexButton().hasAttribute("disabled")).toBe(false);
  });

  it("still shows the three hardcoded providers with a cold cache", () => {
    vi.stubGlobal("fetch", serveNothing());
    render(panel());

    // Labels as `ProviderConfigPicker` renders them — "Claude", not "Claude
    // Code", since #390 shortened it to fit the mobile row.
    for (const label of ["Claude", "Codex", "pi"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });
});

describe("the refresh — what the panel believes", () => {
  // Deliberately no "does it hit the network" case here. It would not
  // discriminate: the cached default *also* puts a request on the wire — that is
  // what the background revalidation is — it simply never hands the answer back
  // to the caller. What separates the two is which payload the panel ends up
  // believing, which is exactly what the pair below measures.

  it("disables Codex once the daemon says it is no longer configured", async () => {
    vi.stubGlobal("fetch", serve(payload(true)));
    await getSystemInfo();

    vi.stubGlobal("fetch", serve(payload(false)));
    render(panel());

    // On the cached default this never came true: the revalidation updated the
    // module cache and the panel was never told.
    await waitFor(() => expect(codexButton().hasAttribute("disabled")).toBe(true));
  });

  it("keeps Codex enabled when the daemon confirms it is configured", async () => {
    // The other half, so the case above is not satisfied by a component that
    // disables the button unconditionally once any payload arrives.
    vi.stubGlobal("fetch", serve(payload(true)));
    await getSystemInfo();

    const fresh = serve(payload(true));
    vi.stubGlobal("fetch", fresh);
    render(panel());

    await waitFor(() => expect(fresh.mock.calls.some(([url]) => String(url).includes("/system-info"))).toBe(true));
    await waitFor(() => expect(codexButton().hasAttribute("disabled")).toBe(false));
  });
});
