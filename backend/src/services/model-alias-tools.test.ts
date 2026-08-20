/**
 * Merge semantics of set_model_alias.
 *
 * The tool merges per-provider targets rather than replacing the map, and that
 * is what keeps a target it does not mention alive. It matters most for
 * `openrouter`: the harness was removed, so nothing resolves that target and
 * nothing should set a new one, but values stored before the removal are user
 * data and the settings page carries them silently. If this tool replaced
 * instead of merged, any agent editing an unrelated provider would delete them
 * — with no second copy, since writing the registry also retires the legacy
 * `openRouterModelAliases` map it was migrated from.
 *
 * agent-settings is mocked so the registry is an in-memory value rather than
 * the host's real agent-settings.json.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { AgentSettings, ModelAlias } from "shared";

let settings: AgentSettings;

vi.mock("./agent-settings.js", () => ({
  getAgentSettings: vi.fn((): AgentSettings => settings),
  updateAgentSettings: vi.fn((patch: Partial<AgentSettings>): AgentSettings => {
    settings = { ...settings, ...patch };
    return settings;
  }),
}));

import { buildModelAliasTools } from "./model-alias-tools.js";

/** What every handler in this file returns, once its JSON payload is parsed. */
interface AliasToolResult {
  modelAliases?: ModelAlias[];
  error?: string;
}

/** Invoke one of the built tools by name and parse its JSON payload. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<AliasToolResult> {
  const tool = buildModelAliasTools().find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const res = await (tool.handler as (a: unknown) => Promise<{ content: { text: string }[] }>)(args);
  return JSON.parse(res.content[0].text) as AliasToolResult;
}

const aliasNamed = (payload: AliasToolResult, name: string) => payload.modelAliases?.find((a) => a.name === name);

describe("set_model_alias merge semantics", () => {
  beforeEach(() => {
    settings = {
      proxyMode: "local",
      modelAliases: [
        { name: "planner", targets: { "claude-code": "opus", openrouter: "anthropic/claude-opus-4.8" } },
        { name: "legacy", targets: { openrouter: "moonshotai/kimi-k2" } },
      ],
    };
  });

  it("preserves a retired openrouter target when another provider is set", async () => {
    const out = await call("set_model_alias", { name: "planner", codex: "gpt-5.5" });

    expect(aliasNamed(out, "planner")?.targets).toEqual({
      "claude-code": "opus",
      openrouter: "anthropic/claude-opus-4.8",
      codex: "gpt-5.5",
    });
  });

  it("preserves it even when the parameter is never passed", async () => {
    // The guarantee does not rest on the tool exposing an `openrouter`
    // parameter — an omitted target is left unchanged by the merge.
    await call("set_model_alias", { name: "planner", cline: "claude-sonnet-4-6" });
    const out = await call("set_model_alias", { name: "planner", pi: "google/gemini-3.6-flash" });

    expect(aliasNamed(out, "planner")?.targets.openrouter).toBe("anthropic/claude-opus-4.8");
  });

  it("does not disturb other aliases", async () => {
    const out = await call("set_model_alias", { name: "planner", codex: "gpt-5.5" });

    expect(aliasNamed(out, "legacy")?.targets).toEqual({ openrouter: "moonshotai/kimi-k2" });
  });

  it('clears the retired target on an explicit ""', async () => {
    const out = await call("set_model_alias", { name: "planner", openrouter: "" });

    expect(aliasNamed(out, "planner")?.targets).toEqual({ "claude-code": "opus" });
  });

  it("refuses to clear the last remaining target", async () => {
    // "legacy" has only the retired slug, so clearing it would leave an alias
    // with nothing to resolve to — rejected rather than silently dropped.
    const out = await call("set_model_alias", { name: "legacy", openrouter: "" });

    expect(out.error).toMatch(/at least one provider target/);
    expect(aliasNamed(await call("list_model_aliases"), "legacy")?.targets).toEqual({ openrouter: "moonshotai/kimi-k2" });
  });

  it("retires the legacy openRouterModelAliases map on write", async () => {
    settings.openRouterModelAliases = { planner: "anthropic/claude-opus-4.8" };

    await call("set_model_alias", { name: "planner", codex: "gpt-5.5" });

    expect(settings.openRouterModelAliases).toBeUndefined();
  });
});
