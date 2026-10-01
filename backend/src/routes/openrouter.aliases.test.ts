/**
 * `GET /api/openrouter/models` must not offer model aliases it cannot honour.
 *
 * The route used to pin every entry of the deprecated `openRouterModelAliases`
 * map at the top of the OpenRouter model picker. Those aliases were migrated
 * into the cross-harness registry with only an `openrouter` target, and that
 * target resolves nowhere since the OpenRouter engine was removed (#336). Every
 * consumer of the picker resolves against something else:
 *
 *  - per-chat Claude Code / Codex models (routed through OpenRouter) resolve
 *    against `claude-code` / `codex`, so a legacy alias has no target there,
 *    and the chat silently falls back to the default model;
 *  - the Settings → API routed-model fields and the utility-completion models
 *    are used verbatim, so the alias *name* is sent to OpenRouter as a slug.
 *
 * So the route keeps the `aliases` key (an older tab reads it) but serves it
 * empty. Cross-harness aliases are managed in Settings → Model Aliases and are
 * accepted wherever a model is typed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { AgentSettings } from "shared";

/** A user who set up OpenRouter aliases before the cross-harness registry existed. */
const legacySettings: AgentSettings = {
  proxyMode: "local",
  openRouterApiKey: "sk-or-test",
  openRouterModelAliases: { planner: "deepseek/deepseek-chat", "low coder": "moonshotai/kimi-k2" },
};

vi.mock("../services/agent-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/agent-settings.js")>()),
  getAgentSettings: vi.fn(() => legacySettings),
}));

const { openRouterRouter } = await import("./openrouter.js");
const { resolveModelAlias } = await import("../services/agent-settings.js");
const { resetOpenRouterModelsCacheForTesting } = await import("../services/openrouter-models.js");

function getModels(): Promise<{ code: number; body: any }> {
  const layer = (openRouterRouter as any).stack.find((l: any) => l.route?.path === "/models" && l.route.methods.get);
  const handler = layer.route.stack[0].handle as (req: Request, res: Response) => Promise<void>;
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    void handler({} as Request, res as unknown as Response);
  });
}

beforeEach(() => {
  resetOpenRouterModelsCacheForTesting();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        data: ["deepseek/deepseek-chat", "moonshotai/kimi-k2"].map((id) => ({
          id,
          name: id,
          supported_parameters: ["tools"],
          pricing: { prompt: "0.000001", completion: "0.000002" },
        })),
      }),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOpenRouterModelsCacheForTesting();
});

describe("GET /api/openrouter/models", () => {
  it("serves the model catalog", async () => {
    const { code, body } = await getModels();
    expect(code).toBe(200);
    expect(body.models.map((m: any) => m.id)).toEqual(expect.arrayContaining(["deepseek/deepseek-chat", "moonshotai/kimi-k2"]));
  });

  it("offers no legacy OpenRouter aliases, but keeps the key for older tabs", async () => {
    const { body } = await getModels();
    expect(body.aliases).toEqual([]);
  });

  it("(why) a legacy alias resolves for none of the picker's consumers", () => {
    for (const provider of ["claude-code", "codex"] as const) {
      expect(resolveModelAlias("planner", provider, legacySettings)).toBeUndefined();
    }
  });
});
