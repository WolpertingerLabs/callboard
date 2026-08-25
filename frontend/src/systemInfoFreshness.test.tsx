/**
 * Guards the call sites, not the option.
 *
 * `api.systemInfo.test.ts` proves `{refresh: true}` bypasses the cache. That is
 * necessary and not sufficient: drop the flag from any single caller and every
 * one of those tests stays green, because nothing there asserts which callers
 * pass it. And the failure is silent by construction — a stale payload renders
 * perfectly, it is just describing a daemon state that has moved on.
 *
 * So each component below is mounted for real, against a mocked `api` module,
 * and the assertion is on the argument that actually reached `getSystemInfo`.
 * Three callers, three reasons the cached default is wrong for them:
 *
 * | Caller | Why it cannot be stale |
 * |---|---|
 * | `NewChatPanel` | gates a provider button; stale ⇒ an uninstalled CLI is offered and the chat fails at start |
 * | `AboutSettings` | its whole job is reporting current daemon state, including the update banner |
 * | `CronJobs` | gates a *scheduled* job; stale ⇒ failure hours later, unattended |
 *
 * Assertions are "some call passed the flag" rather than "the first call did",
 * because these components nest others that read the same endpoint —
 * `NewChatPanel` renders `ClaudeModelSelector`, which correctly takes the cached
 * default — and a positional assertion would be pinning render order instead of
 * the contract.
 *
 * ## What this file does not reach
 *
 * `ApiSettings` has five system-info reads and only `loadAll`'s runs on mount;
 * the other four (`handleRefresh`, `handleRecheckEngines`, `handleEnginesUpdated`
 * and the post-save `setTimeout`) hang off user actions on a page that mounts
 * many fetching children of its own. Driving them here would be testing that
 * page rather than this contract, so they are stated as a known gap rather than
 * left as an assumed absence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import type { AgentConfig } from "shared/types/index.js";

const mocks = vi.hoisted(() => ({ getSystemInfo: vi.fn() }));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  getSystemInfo: mocks.getSystemInfo,
}));

const NewChatPanel = (await import("./components/NewChatPanel")).default;
const AboutSettings = (await import("./pages/settings/AboutSettings")).default;
const CronJobs = (await import("./pages/agents/dashboard/CronJobs")).default;

/** Did anything in the mounted tree ask for a guaranteed-fresh payload? */
const askedFresh = () => mocks.getSystemInfo.mock.calls.some(([opts]) => opts?.refresh === true);

const AGENT: AgentConfig = { name: "Test", alias: "test", description: "", createdAt: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.getSystemInfo.mockResolvedValue({ version: "1.0.0", models: [], acpProviders: [], codexConfigured: true, clineProviderId: "anthropic" });
  // Nothing here asserts on the network, but the components under test have
  // other mount-time fetches, and "empty" has to be the shape each unwrapper
  // expects rather than a bare `{}`: `getAgentCronJobs` returns `data.jobs`, so
  // `{}` hands the component `undefined` and it dies on `jobs.filter`. React
  // reports that as an uncaught error, which this file would then carry as
  // permanent noise — the kind that hides the next real one.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ jobs: [], models: [], aliases: [], providers: [] }) })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (node: ReactNode) => <MemoryRouter>{node}</MemoryRouter>;

describe("callers that must not be served a cached payload", () => {
  it("NewChatPanel asks for a fresh one", async () => {
    render(wrap(<NewChatPanel onClose={() => {}} />));
    await waitFor(() => expect(askedFresh()).toBe(true));
  });

  it("AboutSettings asks for a fresh one", async () => {
    render(wrap(<AboutSettings />));
    await waitFor(() => expect(askedFresh()).toBe(true));
  });

  it("CronJobs asks for a fresh one", async () => {
    render(wrap(<CronJobs agent={AGENT} />));
    await waitFor(() => expect(askedFresh()).toBe(true));
  });
});

describe("callers for which the cache is the right default", () => {
  /**
   * The other half of the contract, and the reason this file is not just "pass
   * `refresh` everywhere". This one reads the payload to populate a datalist —
   * it gates nothing — so paying a round trip on every mount would be cost with
   * no answer attached. A future edit that "fixes" it by adding `refresh` should
   * have to change a test that says why that is not a fix.
   */
  it("ModelAliasesSettings takes the cached default", async () => {
    const ModelAliasesSettings = (await import("./pages/settings/ModelAliasesSettings")).default;
    render(wrap(<ModelAliasesSettings />));

    await waitFor(() => expect(mocks.getSystemInfo).toHaveBeenCalled());
    expect(askedFresh()).toBe(false);
  });
});
