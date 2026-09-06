import { describe, expect, it } from "vitest";
import {
  nativeCodexReasoningCapability,
  openRouterReasoningCapability,
  parseOpenRouterReasoning,
  restrictReasoningCapability,
} from "shared/types/reasoning.js";
import type { OpenRouterModelInfo } from "shared/types/openrouter.js";

const model: OpenRouterModelInfo = { id: "vendor/model", name: "Model", promptPrice: "0", completionPrice: "0", supportedParameters: ["tools", "reasoning"] };

describe("reasoning capability contract", () => {
  it("preserves absent, explicit null and empty efforts distinctly", () => {
    expect(parseOpenRouterReasoning({})).toEqual({});
    expect(parseOpenRouterReasoning({ supported_efforts: null })).toEqual({ supportedEfforts: null });
    expect(parseOpenRouterReasoning({ supported_efforts: [] })).toEqual({ supportedEfforts: [] });
    expect(openRouterReasoningCapability(model).efforts).toEqual([]);
    expect(openRouterReasoningCapability({ ...model, reasoning: {} }).efforts).toEqual([]);
    expect(openRouterReasoningCapability({ ...model, reasoning: { supportedEfforts: [] } }).efforts).toEqual([]);
    expect(openRouterReasoningCapability({ ...model, reasoning: { supportedEfforts: null } }).efforts).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
  it("filters malformed and native-only metadata, excluding none when mandatory", () => {
    for (const value of [undefined, null, [], false, "reasoning"]) expect(parseOpenRouterReasoning(value)).toBeUndefined();
    expect(parseOpenRouterReasoning({ supported_efforts: "all", default_effort: "ultra", default_enabled: "yes" })).toEqual({});
    const reasoning = parseOpenRouterReasoning({
      supported_efforts: ["none", "max", "max", "ultra", "persistent", 4],
      mandatory: true,
      default_effort: "none",
      default_enabled: true,
      supports_max_tokens: false,
    });
    expect(reasoning).toEqual({ supportedEfforts: ["none", "max"], mandatory: true, defaultEffort: "none", defaultEnabled: true, supportsMaxTokens: false });
    expect(openRouterReasoningCapability({ ...model, reasoning })).toMatchObject({ efforts: ["max"] });
    expect(openRouterReasoningCapability({ ...model, reasoning }).defaultEffort).toBeUndefined();
    expect(
      openRouterReasoningCapability({ ...model, reasoning: parseOpenRouterReasoning({ supported_efforts: null, mandatory: "false" }) }).efforts,
    ).not.toContain("none");
  });
  it("uses live native catalog only, preserves max/ultra, and separates legacy none", () => {
    const result = nativeCodexReasoningCapability({
      id: "native",
      name: "Native",
      supportedReasoningLevels: ["low", "max", "ultra", "bad", "none"],
      defaultReasoningLevel: "ultra",
    });
    expect(result).toMatchObject({ efforts: ["low", "max", "ultra"], defaultEffort: "ultra", legacySummaryNone: true });
    expect(result.efforts).not.toContain("persistent");
    expect(nativeCodexReasoningCapability()).toMatchObject({ status: "unknown", efforts: [] });
    expect(openRouterReasoningCapability()).toMatchObject({ status: "unknown", efforts: [] });
  });
  it("intersects transport capabilities without silently translating", () => {
    const capability = nativeCodexReasoningCapability({
      id: "native",
      name: "Native",
      supportedReasoningLevels: ["max", "ultra"],
      defaultReasoningLevel: "ultra",
    });
    expect(restrictReasoningCapability(capability, ["max"])).toMatchObject({ efforts: ["max"] });
    expect(restrictReasoningCapability(capability, ["max"]).defaultEffort).toBeUndefined();
  });
});
