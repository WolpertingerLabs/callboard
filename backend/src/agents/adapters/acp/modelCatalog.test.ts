/**
 * The harvested ACP model catalog.
 *
 * The projection (`extractAcpModels`) is the one that shipped broken once, by
 * reading `id` where the schema says `value`, so it is tested against both
 * `SessionConfigSelectOptions` shapes rather than the one OpenCode happens to
 * send.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { acpModelConfigId, extractAcpModels, getAcpModelCatalog, recordAcpModels, resetAcpModelCatalogCache } from "./modelCatalog.js";

let dataDir: string;
let original: string | undefined;

beforeEach(() => {
  original = process.env.CALLBOARD_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "cb-acp-models-"));
  process.env.CALLBOARD_DATA_DIR = dataDir;
  resetAcpModelCatalogCache();
});

afterEach(() => {
  if (original === undefined) delete process.env.CALLBOARD_DATA_DIR;
  else process.env.CALLBOARD_DATA_DIR = original;
  rmSync(dataDir, { recursive: true, force: true });
  resetAcpModelCatalogCache();
});

const flat = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "v/fast",
    options: [
      { value: "v/fast", name: "Fast" },
      { value: "v/slow", name: "Slow", description: "Thinks harder" },
    ],
  },
] as unknown as SessionConfigOption[];

const grouped = [
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "build" }] },
  {
    id: "llm",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "g/one",
    options: [
      {
        group: "vendor",
        name: "Vendor",
        options: [
          { value: "g/one", name: "One" },
          { value: "g/two", name: "Two" },
        ],
      },
    ],
  },
] as unknown as SessionConfigOption[];

describe("extractAcpModels", () => {
  it("reads flat options from `value`, not `id`", () => {
    expect(extractAcpModels(flat)).toEqual({
      models: [
        { value: "v/fast", displayName: "Fast", description: "v/fast" },
        { value: "v/slow", displayName: "Slow", description: "Thinks harder" },
      ],
      currentValue: "v/fast",
    });
  });

  it("flattens grouped options and ignores non-model selectors", () => {
    const { models, currentValue } = extractAcpModels(grouped);
    expect(models.map((m) => m.value)).toEqual(["g/one", "g/two"]);
    expect(currentValue).toBe("g/one");
    // The "mode" selector is a config option too; it is not a model.
    expect(models.some((m) => m.value === "build")).toBe(false);
  });

  it("returns an empty list rather than throwing on junk", () => {
    for (const input of [null, undefined, [], [null], [{ id: "x", category: "model", type: "boolean" }], [{ category: "model", type: "select" }]]) {
      expect(extractAcpModels(input as never).models).toEqual([]);
    }
  });
});

describe("acpModelConfigId", () => {
  it("returns the agent's own id for the model selector", () => {
    // Not hardcoded to "model": `category` is the standardized hint, `id` is
    // what set_config_option takes, and an agent may name them differently.
    expect(acpModelConfigId(flat)).toBe("model");
    expect(acpModelConfigId(grouped)).toBe("llm");
  });

  it("returns null when the agent offers no model option", () => {
    expect(acpModelConfigId([{ id: "mode", name: "Mode", category: "mode", type: "select" }] as never)).toBeNull();
    expect(acpModelConfigId(null)).toBeNull();
  });
});

describe("the catalog", () => {
  it("is empty for a vendor that has never been run", () => {
    expect(getAcpModelCatalog("opencode")).toBeNull();
  });

  it("records what a session advertised, and survives a cache drop", () => {
    recordAcpModels("opencode", flat, "2026-08-04T00:00:00.000Z");
    expect(getAcpModelCatalog("opencode")).toMatchObject({ providerId: "opencode", currentValue: "v/fast", discoveredAt: "2026-08-04T00:00:00.000Z" });

    // Persisted, so the picker is useful on the first chat after a restart
    // rather than the second.
    resetAcpModelCatalogCache();
    expect(getAcpModelCatalog("opencode")?.models.map((m) => m.value)).toEqual(["v/fast", "v/slow"]);
    expect(existsSync(join(dataDir, "acp-models.json"))).toBe(true);
  });

  it("keeps vendors separate", () => {
    recordAcpModels("opencode", flat, "t1");
    recordAcpModels("gemini", grouped, "t2");
    expect(getAcpModelCatalog("opencode")?.models.map((m) => m.value)).toEqual(["v/fast", "v/slow"]);
    expect(getAcpModelCatalog("gemini")?.models.map((m) => m.value)).toEqual(["g/one", "g/two"]);
  });

  it("does not blank a known list when a later session reports no models", () => {
    recordAcpModels("opencode", flat, "t1");
    // An agent that goes quiet about its models has not withdrawn them, and a
    // resumed session need not repeat the catalog.
    recordAcpModels("opencode", [], "t2");
    expect(getAcpModelCatalog("opencode")?.models).toHaveLength(2);
  });

  it("survives a corrupt catalog file instead of taking the daemon down", () => {
    writeFileSync(join(dataDir, "acp-models.json"), "{not json");
    resetAcpModelCatalogCache();
    expect(getAcpModelCatalog("opencode")).toBeNull();
    // And recovers: the next record rewrites the file.
    recordAcpModels("opencode", flat, "t1");
    expect(JSON.parse(readFileSync(join(dataDir, "acp-models.json"), "utf8")).opencode.models).toHaveLength(2);
  });
});
