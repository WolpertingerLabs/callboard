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

describe("buildCodexExtras — third-party MCP servers left out (H-01)", () => {
  const perms = (codeExecution: "allow" | "ask" | "deny") =>
    ({
      fileRead: "allow",
      fileWrite: "allow",
      codeExecution,
      webAccess: "allow",
      browserControl: "deny",
      computerControl: "deny",
      sandboxControl: "deny",
    }) as const;
  const route: CodexExecutionRoute = {
    ...subRoute,
    subscriptionViaOpenRouter: undefined,
    endpoint: "https://api.openai.com/v1",
    developerInstructions: "operator's own",
  };
  const build = (codeExecution: "allow" | "ask" | "deny" | null, extra: Record<string, unknown> = {}) =>
    buildCodexExtras({
      ...ctx({ proxyMode: "local" } as AgentSettings, route),
      getDefaultPermissions: () => (codeExecution ? perms(codeExecution) : null),
      externalMcpServerNames: ["github", "linear"],
      ...extra,
    });

  it.each(["ask", "deny", null] as const)("codeExecution %s: tells the model which servers it was not given, and why", async (level) => {
    const extras = await build(level);
    expect(extras.developerInstructions).toMatch(/^operator's own\n\n/);
    expect(extras.developerInstructions).toContain("not available in this chat: github, linear");
    expect(extras.developerInstructions).toContain("Code execution permission is Allow");
  });

  it("codeExecution allow: no note", async () => {
    expect((await build("allow")).developerInstructions).toBeUndefined();
  });

  it("no third-party servers: no note", async () => {
    expect((await build("deny", { externalMcpServerNames: [] })).developerInstructions).toBeUndefined();
  });

  it("composes with another addition (the aside instruction)", async () => {
    const extras = await build("ask", { additionalInstructions: "ASIDE" });
    expect(extras.developerInstructions).toMatch(/^operator's own\n\nASIDE\n\nThese MCP servers/);
  });
});
