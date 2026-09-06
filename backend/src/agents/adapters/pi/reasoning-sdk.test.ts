/** Installed SDK conformance, entirely offline: prove the clamp we prevent. */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assertPiModelReasoningEffort, findPiModel, piModelReasoningEfforts } from "./modelCatalog.js";
import { resolvePiAgentDir } from "./optionsAdapter.js";

const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const modelsModule = pathToFileURL(join(dirname(sdkEntry), "../node_modules/@earendil-works/pi-ai/dist/models.js")).href;
const sdk = await import(/* @vite-ignore */ modelsModule);

describe("pi SDK thinking effort conformance", () => {
  it("prevents the installed SDK silently clamping o3 xhigh to high", async () => {
    const agentDir = resolvePiAgentDir();
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
    const model = findPiModel(runtime, "openrouter", "openai/o3", null)!;
    expect(sdk.clampThinkingLevel(model, "xhigh")).toBe("high");
    expect(piModelReasoningEfforts(model)).toEqual(sdk.getSupportedThinkingLevels(model).map((level: string) => (level === "off" ? "none" : level)));
    expect(() => assertPiModelReasoningEffort(model, "xhigh")).toThrow("cannot express");
    expect(() => assertPiModelReasoningEffort(model, "high")).not.toThrow();
  });
  it("keeps explicit SDK null restrictions and supported xhigh mappings", () => {
    const model = { reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "xhigh" } };
    expect(piModelReasoningEfforts(model)).toEqual(sdk.getSupportedThinkingLevels(model).map((level: string) => (level === "off" ? "none" : level)));
    expect(sdk.clampThinkingLevel(model, "xhigh")).toBe("xhigh");
    expect(() => assertPiModelReasoningEffort(model, "minimal")).toThrow("cannot express");
  });
});
