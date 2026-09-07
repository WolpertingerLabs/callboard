import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  injected: false,
  ambient: false,
  routeUnknown: false,
  defaultModel: undefined as string | undefined,
  native: vi.fn(),
  or: vi.fn(),
  probe: vi.fn(),
}));
vi.mock("./agent-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-settings.js")>()),
  getAgentSettings: () => mocks.settings,
}));
vi.mock("./codex-execution-route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./codex-execution-route.js")>()),
  resolveCodexExecutionRoute: async (...args: unknown[]) => {
    mocks.probe(...args);
    if (mocks.routeUnknown) return { route: "unknown", injectedOpenRouter: false };
    return {
      route: mocks.injected || mocks.ambient ? "openrouter" : "codex",
      endpoint: mocks.injected || mocks.ambient ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1",
      injectedOpenRouter: mocks.injected,
      ...(mocks.defaultModel && !mocks.injected ? { defaultModel: mocks.defaultModel } : {}),
    };
  },
}));
vi.mock("../agents/adapters/pi/modelCatalog.js", () => ({ getPiModelReasoningEfforts: async () => ["none", "minimal", "low", "medium", "high"] }));
vi.mock("./codex-models.js", () => ({ getCodexModelsAsync: mocks.native }));
vi.mock("./openrouter-models.js", () => ({ getOpenRouterModelsAsync: mocks.or }));
import { assertReasoningEffort, assertStoredReasoningEffort, resolveReasoningCapability, resolveReasoningTarget } from "./reasoning-capabilities.js";
beforeEach(() => {
  mocks.settings = { codexModel: "native", codexOpenRouterModel: "vendor/routed", clineModel: "cline-model", piModel: "vendor/routed" };
  mocks.injected = false;
  mocks.ambient = false;
  mocks.routeUnknown = false;
  mocks.defaultModel = undefined;
  mocks.probe.mockReset();
  mocks.native.mockResolvedValue([{ id: "native", defaultReasoningLevel: "medium", supportedReasoningLevels: ["low", "medium", "max", "ultra"] }]);
  mocks.or.mockResolvedValue([{ id: "vendor/routed", reasoning: { supportedEfforts: null } }]);
});
describe("effective reasoning resolution", () => {
  it("uses native defaults and live max/ultra despite unrelated OR credentials", async () => {
    mocks.settings.openRouterApiKey = "unrelated";
    expect(await resolveReasoningCapability({ provider: "codex" })).toMatchObject({
      route: "codex",
      model: "native",
      efforts: ["low", "medium", "max", "ultra"],
      defaultEffort: "medium",
    });
    await expect(assertReasoningEffort({ provider: "codex", effort: "ultra" })).resolves.toBeUndefined();
  });
  it("resolves override aliases and missing alias targets through execution defaults", async () => {
    mocks.settings.modelAliases = [
      { name: "fast", targets: { codex: "override" } },
      { name: "other", targets: { pi: "elsewhere" } },
    ];
    expect((await resolveReasoningTarget({ provider: "codex", model: "FAST" })).model).toBe("override");
    expect((await resolveReasoningTarget({ provider: "codex", model: "other" })).model).toBe("native");
  });
  it("uses OR defaults only on injected routing and never offers ultra", async () => {
    mocks.injected = true;
    const capability = await resolveReasoningCapability({ provider: "codex" });
    expect(capability).toMatchObject({ route: "openrouter", model: "vendor/routed" });
    expect(capability.efforts).toContain("max");
    expect(capability.efforts).not.toContain("ultra");
    expect(capability.efforts).toContain("none");
    await expect(assertReasoningEffort({ provider: "codex", effort: "ultra" })).rejects.toThrow("not supported");
  });
  it("ambient routing changes capabilities without changing execution's model default", async () => {
    mocks.ambient = true;
    expect(await resolveReasoningTarget({ provider: "codex" })).toMatchObject({ route: "openrouter", model: "native" });
    await expect(assertReasoningEffort({ provider: "codex", effort: "none" })).rejects.toThrow("not supported");
  });
  it("unknown/offline models allow default but reject explicit tiers, preserving native legacy summary none", async () => {
    mocks.native.mockResolvedValue([]);
    await expect(assertReasoningEffort({ provider: "codex" })).resolves.toBeUndefined();
    await expect(assertReasoningEffort({ provider: "codex", effort: "max" })).rejects.toThrow("Clear the effort");
    await expect(assertReasoningEffort({ provider: "codex", effort: "none" })).resolves.toBeUndefined();
  });
  it("Cline/pi OR settings intersect gateway tiers with adapter vocabulary", async () => {
    mocks.settings.clineProviderId = "openrouter";
    for (const provider of ["cline", "pi"]) {
      const cap = await resolveReasoningCapability({ provider, model: "vendor/routed" });
      expect(cap.route).toBe("openrouter");
      expect(cap.efforts).not.toContain("max");
      expect(cap.efforts).not.toContain("ultra");
    }
  });
  it("rejects malformed explicit values and efforts on unsupported harnesses", async () => {
    await expect(assertReasoningEffort({ provider: "codex", effort: {} })).rejects.toThrow("not supported");
    await expect(assertReasoningEffort({ provider: "claude-code", effort: "high" })).rejects.toThrow("does not expose");
  });
});

it("recognizes Cline/pi explicit OpenRouter base URL routing, not unrelated keys", async () => {
  mocks.settings.clineProviderId = "openai-native";
  mocks.settings.clineBaseUrl = "https://openrouter.ai/api/v1";
  mocks.settings.piProviderId = "openai";
  mocks.settings.piBaseUrl = "https://openrouter.ai/api/v1";
  expect((await resolveReasoningTarget({ provider: "cline" })).route).toBe("openrouter");
  expect((await resolveReasoningTarget({ provider: "pi" })).route).toBe("openrouter");
});

it("does not label gateway defaults as Codex CLI defaults", async () => {
  mocks.injected = true;
  mocks.or.mockResolvedValue([{ id: "vendor/routed", reasoning: { supportedEfforts: null, defaultEffort: "high", defaultEnabled: false } }]);
  const capability = await resolveReasoningCapability({ provider: "codex" });
  expect(capability.defaultEffort).toBeUndefined();
  expect(capability.message).toContain("not the gateway default");
});

it("scopes Codex capabilities to execution's official endpoint rather than utility configuration", async () => {
  mocks.injected = true;
  mocks.settings.openRouterBaseUrl = "https://unrelated.example/v1";
  await resolveReasoningCapability({ provider: "codex" });
  expect(mocks.or).toHaveBeenLastCalledWith("https://openrouter.ai/api/v1");
});
it("rejects OR Pi xhigh when its actual SDK model would clamp to high", async () => {
  await expect(assertReasoningEffort({ provider: "pi", model: "vendor/routed", effort: "xhigh" })).rejects.toThrow("not supported");
  await expect(assertReasoningEffort({ provider: "pi", model: "vendor/routed", effort: "high" })).resolves.toBeUndefined();
});

describe("Codex chats without a configured model", () => {
  // The production default: subscription mode leaves codexModel null and the
  // overwhelming majority of Codex chats store an effort but no model.
  beforeEach(() => {
    mocks.settings.codexModel = null;
    mocks.defaultModel = "native";
  });
  it("resolves capabilities against the CLI's own default model instead of refusing every effort", async () => {
    expect(await resolveReasoningTarget({ provider: "codex" })).toMatchObject({ model: undefined, defaultModel: "native" });
    expect(await resolveReasoningCapability({ provider: "codex" })).toMatchObject({ status: "known", model: "native", efforts: ["low", "medium", "max", "ultra"] });
    await expect(assertReasoningEffort({ provider: "codex", effort: "max" })).resolves.toBeUndefined();
    await expect(assertReasoningEffort({ provider: "codex", effort: "xhigh" })).rejects.toThrow("not supported");
  });
  it("still executes with no pinned model: the default is for capabilities only", async () => {
    expect((await resolveReasoningTarget({ provider: "codex" })).model).toBeUndefined();
    expect((await resolveReasoningTarget({ provider: "codex", model: "explicit" })).model).toBe("explicit");
  });
  it("stays unknown when the CLI cannot name its default", async () => {
    mocks.defaultModel = undefined;
    expect(await resolveReasoningCapability({ provider: "codex" })).toMatchObject({ status: "unknown", efforts: [] });
    await expect(assertReasoningEffort({ provider: "codex", effort: "high" })).rejects.toThrow("not supported");
  });
  it("does not lend the native default to injected OpenRouter routing", async () => {
    mocks.injected = true;
    mocks.settings.codexOpenRouterModel = null;
    expect(await resolveReasoningCapability({ provider: "codex" })).toMatchObject({ route: "openrouter", status: "unknown" });
  });
});

describe("stored efforts on the execution path", () => {
  it("lets an effort through when the route probe or catalog cannot verify it", async () => {
    mocks.routeUnknown = true;
    await expect(assertReasoningEffort({ provider: "codex", effort: "high" })).rejects.toThrow("not supported");
    await expect(assertStoredReasoningEffort({ provider: "codex", effort: "high" })).resolves.toBeUndefined();
    mocks.routeUnknown = false;
    mocks.native.mockResolvedValue([]);
    await expect(assertStoredReasoningEffort({ provider: "codex", effort: "xhigh" })).resolves.toBeUndefined();
    mocks.native.mockResolvedValue([{ id: "native" }]);
    await expect(assertStoredReasoningEffort({ provider: "codex", effort: "xhigh" })).resolves.toBeUndefined();
  });
  it("still refuses an effort the catalog knows the model does not support", async () => {
    await expect(assertStoredReasoningEffort({ provider: "codex", effort: "xhigh" })).rejects.toThrow("not supported");
    await expect(assertStoredReasoningEffort({ provider: "codex", effort: "ultra" })).resolves.toBeUndefined();
    await expect(assertStoredReasoningEffort({ provider: "codex", effort: {} })).rejects.toThrow("not supported");
    await expect(assertStoredReasoningEffort({ provider: "claude-code", effort: "high" })).rejects.toThrow("does not expose");
  });
  it("reuses a route the caller already probed instead of spawning the CLI again", async () => {
    const codexRoute = { route: "codex" as const, endpoint: "https://api.openai.com/v1", injectedOpenRouter: false };
    await assertStoredReasoningEffort({ provider: "codex", effort: "max", codexRoute });
    expect((await resolveReasoningTarget({ provider: "codex", codexRoute })).route).toBe("codex");
    expect(mocks.probe).not.toHaveBeenCalled();
    await resolveReasoningTarget({ provider: "codex" });
    expect(mocks.probe).toHaveBeenCalledTimes(1);
  });
});
