/**
 * generateThemeCSS's contrast gate, driven end to end through MockAgentProvider.
 *
 * The unit tests in theme-contrast.test.ts prove the measurement and the
 * correction; these prove the thing that actually protects users — that a
 * sub-AA theme never leaves this function unrepaired, and that one which cannot
 * be repaired is regenerated and then refused rather than stored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAgentProviderForTesting } from "../agents/factory.js";
import { MockAgentProvider } from "../agents/adapters/mock/MockAgentProvider.js";

vi.mock("./agent-settings.js", () => ({
  getClaudeCodeExecutablePath: () => undefined,
  isOpenRouterConfigured: vi.fn(() => false),
  getAgentSettings: vi.fn(() => ({ proxyMode: "local" })),
}));

import { generateThemeCSS } from "./quick-completion.js";
import { THEME_VARIABLE_NAMES } from "./theme-variables.js";
import { BUILTIN_PALETTE } from "./theme-contrast-palette.js";
import { auditThemeVars, measureMode } from "./theme-contrast.js";
import { getAgentSettings, isOpenRouterConfigured } from "./agent-settings.js";

const mockIsOpenRouterConfigured = vi.mocked(isOpenRouterConfigured);
const mockGetAgentSettings = vi.mocked(getAgentSettings);

beforeEach(() => {
  mockIsOpenRouterConfigured.mockReturnValue(false);
  mockGetAgentSettings.mockReturnValue({ proxyMode: "local" });
});

afterEach(() => {
  setAgentProviderForTesting(null);
  vi.clearAllMocks();
});

async function waitForSpec(mock: MockAgentProvider, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (mock.toolSpecs.length > 0) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("timed out waiting for buildToolServer to be called");
}

/** Answer the next generation call with `text`, then forget it was asked. */
async function answerOnce(mock: MockAgentProvider, text: string): Promise<void> {
  await waitForSpec(mock);
  const spec = mock.toolSpecs.find((s) => s.name === "qc");
  if (!spec) throw new Error("qc tool-server spec not found");
  const returnResult = spec.tools.find((t) => t.name === "return_result");
  if (!returnResult) throw new Error("return_result tool not found");
  mock.toolSpecs.length = 0;
  await returnResult.handler({ result: text });
}

/** A theme in the shape the prompt asks for, with the given overrides applied. */
function themeJson(dark: Record<string, string> = {}, light: Record<string, string> = {}): string {
  const pick = (palette: Record<string, string>, overrides: Record<string, string>) =>
    Object.fromEntries(THEME_VARIABLE_NAMES.map((name) => [name, overrides[name] ?? palette[name]]));
  return JSON.stringify({ dark: pick(BUILTIN_PALETTE.dark, dark), light: pick(BUILTIN_PALETTE.light, light) });
}

describe("generateThemeCSS — contrast gate", () => {
  it("corrects a sub-AA value before returning, and the returned theme measures clean at that pairing", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    // amber-500 as triggered-badge text: 1.71:1, the worst pairing #293 met.
    const pending = generateThemeCSS("Amber", "amber everything");
    await answerOnce(mock, themeJson({}, { "status-triggered": "#f59e0b" }));
    const theme = await pending;

    expect(theme).not.toBeNull();
    expect(theme!.light["status-triggered"]).not.toBe("#f59e0b");
    const measured = measureMode(theme!.light, "light").find((m) => m.pairing.id === "chatlist-badge-triggered");
    expect(measured!.ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("passes an unfixable pairing back to the model and accepts the second answer", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const pending = generateThemeCSS("Pale", "barely-there pastels");
    // A near-white hover fill under white text: no lightness inside the budget
    // rescues it, so this attempt must be rejected rather than clamped.
    await answerOnce(mock, themeJson({}, { "accent-hover": "#fdfdfd" }));
    await answerOnce(mock, themeJson({}, { "accent-hover": "#6d5ad8" }));
    const theme = await pending;

    expect(theme).not.toBeNull();
    expect(theme!.light["accent-hover"]).toBe("#6d5ad8");
  });

  it("rejects rather than storing a theme that stays unreadable after a retry", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const pending = generateThemeCSS("Invisible", "white on white");
    await answerOnce(mock, themeJson({}, { "accent-hover": "#fdfdfd" }));
    await answerOnce(mock, themeJson({}, { "accent-hover": "#fefefe" }));

    expect(await pending).toBeNull();
  });

  it("still rejects a response that is not a theme at all", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const pending = generateThemeCSS("Broken", "anything");
    await answerOnce(mock, "I'm afraid I can't do that.");

    expect(await pending).toBeNull();
  });

  it("keeps every variable it was asked for, so nothing silently falls back to the stylesheet", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const pending = generateThemeCSS("Complete", "anything");
    await answerOnce(mock, themeJson({}, { "status-triggered": "#f59e0b" }));
    const theme = await pending;

    for (const name of THEME_VARIABLE_NAMES) {
      expect(theme!.dark, `dark --${name}`).toHaveProperty(name);
      expect(theme!.light, `light --${name}`).toHaveProperty(name);
    }
  });

  it("drops a variable the theme is not allowed to define, rather than pinning the derived layer", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const payload = JSON.parse(themeJson());
    payload.light["chatlist-badge-triggered-bg"] = "#ff00ff";
    payload.light["not-a-real-variable"] = "#123456";

    const pending = generateThemeCSS("Overreach", "anything");
    await answerOnce(mock, JSON.stringify(payload));
    const theme = await pending;

    expect(theme!.light).not.toHaveProperty("chatlist-badge-triggered-bg");
    expect(theme!.light).not.toHaveProperty("not-a-real-variable");
    expect(theme!.light).toHaveProperty("status-triggered");
  });

  it("does not accept a colour it cannot read as if it had passed", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    // A named CSS colour. Silently treating an unparseable value as black would
    // let a theme through on a measurement that never happened.
    const pending = generateThemeCSS("Named", "goldenrod everything");
    await answerOnce(mock, themeJson({}, { warning: "goldenrod" }));
    await answerOnce(mock, themeJson({}, { warning: "goldenrod" }));

    expect(await pending).toBeNull();
  });

  it("returns a theme whose own audit is clean", async () => {
    const mock = new MockAgentProvider();
    setAgentProviderForTesting(mock);

    const pending = generateThemeCSS("Clean", "anything");
    await answerOnce(mock, themeJson({}, { "status-triggered": "#f59e0b", warning: "#ca8a04" }));
    const theme = await pending;

    expect(auditThemeVars(theme!.dark, theme!.light).failures).toEqual([]);
  });
});
