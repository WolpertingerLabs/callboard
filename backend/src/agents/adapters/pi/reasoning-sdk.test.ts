/** Installed SDK conformance, entirely offline: prove the clamp we prevent. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as sdk from "@earendil-works/pi-ai/models";
import { assertPiModelReasoningEffort, findPiModel, piModelReasoningEfforts } from "./modelCatalog.js";
import { resolvePiAgentDir } from "./optionsAdapter.js";
import { piAiVersions } from "./__fixtures__/piAiVersion.js";

describe("pi SDK thinking effort conformance", () => {
  it("is checking the pi-ai the pinned coding agent actually runs", () => {
    const { resolved, expected } = piAiVersions();
    expect(resolved).toBe(expected);
  });

  it("prevents the installed SDK silently clamping o3 xhigh to high", async () => {
    const agentDir = resolvePiAgentDir();
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
    const model = findPiModel(runtime, "openrouter", "openai/o3", null)!;
    expect(sdk.clampThinkingLevel(model, "xhigh")).toBe("high");
    expect(piModelReasoningEfforts(model)).toEqual(sdk.getSupportedThinkingLevels(model as never).map((level: string) => (level === "off" ? "none" : level)));
    expect(() => assertPiModelReasoningEffort(model, "xhigh")).toThrow("cannot express");
    expect(() => assertPiModelReasoningEffort(model, "high")).not.toThrow();
  });
  it("keeps explicit SDK null restrictions and supported xhigh mappings", () => {
    const model = { reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "xhigh" } };
    expect(piModelReasoningEfforts(model)).toEqual(sdk.getSupportedThinkingLevels(model as never).map((level: string) => (level === "off" ? "none" : level)));
    expect(sdk.clampThinkingLevel(model as never, "xhigh")).toBe("xhigh");
    expect(() => assertPiModelReasoningEffort(model, "minimal")).toThrow("cannot express");
  });
});
