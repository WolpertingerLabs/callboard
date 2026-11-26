import { describe, expect, it } from "vitest";
import type { AgentSettings } from "shared";
import { buildCodexExtras } from "./provider-session-options.js";
import type { CodexExecutionRoute } from "./codex-execution-route.js";

const ctx = (agentSettings: AgentSettings, codexRoute: CodexExecutionRoute) => ({
  agentSettings,
  folder: "/tmp",
  chatModel: undefined,
  chatEffort: undefined,
  getDefaultPermissions: () => null,
  trackingId: "t",
  codexRoute,
});

const subRoute: CodexExecutionRoute = {
  route: "codex",
  endpoint: "https://openrouter.ai/api/v1",
  injectedOpenRouter: false,
  subscriptionViaOpenRouter: true,
  uiAliasPresence: { "callboard-ui": false, callboard_ui: false },
  developerInstructions: null,
};

describe("buildCodexExtras — subscription via OpenRouter", () => {
  it("carries the flag with native reasoning and the native model field", async () => {
    const settings = {
      proxyMode: "local",
      codexSubscriptionViaOpenRouter: true,
      openRouterApiKey: "k",
      codexModel: "gpt-5.5",
      codexOpenRouterModel: "openai/x",
    } as AgentSettings;
    const extras = await buildCodexExtras(ctx(settings, subRoute));
    expect(extras).toMatchObject({ authMode: "subscription", subscriptionViaOpenRouter: true, reasoningRoute: "native", model: "gpt-5.5" });
    expect(extras.useOpenRouter).toBeUndefined();
    expect(extras.directUiNamespaces).toBeUndefined();
  });

  it("is absent on a native route", async () => {
    const extras = await buildCodexExtras(
      ctx({ proxyMode: "local" } as AgentSettings, { ...subRoute, endpoint: "https://api.openai.com/v1", subscriptionViaOpenRouter: undefined }),
    );
    expect(extras.subscriptionViaOpenRouter).toBeUndefined();
  });

  it("is dropped when the route says the full OpenRouter mode is injected", async () => {
    const extras = await buildCodexExtras(
      ctx({ proxyMode: "local", codexUseOpenRouter: true, codexOpenRouterApiKey: "k" } as AgentSettings, {
        ...subRoute,
        route: "openrouter",
        injectedOpenRouter: true,
      }),
    );
    expect(extras.useOpenRouter).toBe(true);
    expect(extras.subscriptionViaOpenRouter).toBeUndefined();
  });
});
