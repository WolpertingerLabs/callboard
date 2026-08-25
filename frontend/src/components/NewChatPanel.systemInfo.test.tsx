/**
 * The New Chat popup's provider row: painted from cache, believed from the wire.
 *
 * This is the suite for the behaviour the whole change exists to produce, and
 * for the regression the first cut of it introduced. Both live in the same two
 * lines of `NewChatPanel`, pulling in opposite directions:
 *
 * - **The seed.** `cachedSystemInfo()` is read synchronously into initial state,
 *   because `useEffect` runs after the first paint by definition. Without it the
 *   OpenCode button — the only provider button built from server data rather
 *   than hardcoded JSX — arrived a round trip after the other four and reflowed
 *   the row.
 * - **The refresh.** The effect asks the daemon again with `{refresh: true}`.
 *   `getSystemInfo()`'s cached default resolves with the last payload this tab
 *   saw and hands the revalidation to the module cache rather than to the
 *   caller, so taking the default pinned the panel to a stale vendor list for
 *   its entire lifetime — a button for an uninstalled CLI, rendered *enabled*,
 *   which `downgradeProvider` then agreed with.
 *
 * So the cases below come in pairs: one that the button is there without the
 * network, one that it is not there when there is nothing cached (or the first
 * would pass vacuously), and one that a vendor uninstalled since the cache
 * warmed is corrected once the daemon answers.
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

const OPENCODE = (available: boolean) => [{ id: "opencode", label: "OpenCode", available, command: "opencode" }];

const payload = (acpProviders: ReturnType<typeof OPENCODE>) => ({
  version: "1.0.0",
  acpProviders,
  codexConfigured: true,
  clineProviderId: "anthropic",
});

/** Resolve `/system-info` with `body`; answer anything else the panel touches harmlessly. */
function serve(body: unknown) {
  return vi.fn((url: string) =>
    String(url).includes("/system-info")
      ? Promise.resolve({ ok: true, json: async () => body })
      : Promise.resolve({ ok: true, json: async () => ({}) }),
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

describe("the seed — what paints before the daemon answers", () => {
  it("renders the OpenCode button without waiting for the network", async () => {
    // Warm the cache the way a previous popup open (or the composer, or the
    // model selector) would have.
    vi.stubGlobal("fetch", serve(payload(OPENCODE(true))));
    await getSystemInfo();

    // From here on nothing resolves, so the effect cannot contribute.
    vi.stubGlobal("fetch", serveNothing());
    render(panel());

    expect(screen.getByRole("button", { name: "OpenCode" })).toBeTruthy();
  });

  it("renders no vendor button when this tab has never fetched", () => {
    // The control. Without this the case above would pass on a component that
    // rendered "OpenCode" unconditionally.
    vi.stubGlobal("fetch", serveNothing());
    render(panel());

    expect(screen.queryByRole("button", { name: "OpenCode" })).toBeNull();
  });

  it("still shows the four hardcoded providers with a cold cache", () => {
    // Which is why only the ACP button ever popped in: these four never needed
    // the payload, so the row was drawn and then reflowed when the fifth landed.
    vi.stubGlobal("fetch", serveNothing());
    render(panel());

    // Labels as `ProviderConfigPicker` renders them — "Claude", not "Claude
    // Code", since #390 shortened it to fit the mobile row.
    for (const label of ["Claude", "Codex", "Cline", "pi"]) {
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

  it("disables a vendor that was uninstalled since the cache warmed", async () => {
    // The regression, end to end. The cache says OpenCode is installed; it is
    // not any more. Serving stale for the popup's whole lifetime left this
    // button enabled and clickable, and the chat then failed at start instead of
    // falling back.
    vi.stubGlobal("fetch", serve(payload(OPENCODE(true))));
    await getSystemInfo();

    vi.stubGlobal("fetch", serve(payload(OPENCODE(false))));
    render(panel());

    // Painted from the seed first, and still enabled — that is all this tab knew
    // when the frame was drawn, and drawing *something* is the point of the seed.
    expect(screen.getByRole("button", { name: "OpenCode" }).hasAttribute("disabled")).toBe(false);

    // …and corrected as soon as the daemon answers. On the cached default this
    // second assertion never came true: the revalidation updated the module
    // cache and the panel was never told.
    await waitFor(() => expect(screen.getByRole("button", { name: "OpenCode" }).hasAttribute("disabled")).toBe(true));
  });

  it("keeps the button enabled when the daemon confirms the vendor is installed", async () => {
    // The other half, so the case above is not satisfied by a component that
    // disables the button unconditionally once any payload arrives.
    vi.stubGlobal("fetch", serve(payload(OPENCODE(true))));
    await getSystemInfo();

    vi.stubGlobal("fetch", serve(payload(OPENCODE(true))));
    render(panel());

    await waitFor(() => expect(screen.getByRole("button", { name: "OpenCode" }).hasAttribute("disabled")).toBe(false));
  });
});
