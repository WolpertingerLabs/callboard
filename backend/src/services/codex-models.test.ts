import { describe, expect, it } from "vitest";
import { codexCatalogWarning, parseCodexModelsCatalog } from "./codex-models.js";

describe("parseCodexModelsCatalog", () => {
  it("maps the Codex CLI model catalog into Callboard's trimmed shape", () => {
    const models = parseCodexModelsCatalog({
      models: [
        {
          slug: "hidden-review",
          display_name: "Hidden Review",
          visibility: "hide",
        },
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          description: "Frontier model",
          visibility: "list",
          supported_in_api: true,
          default_reasoning_level: "medium",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
          service_tiers: [{ id: "priority" }],
        },
      ],
    });

    expect(models).toEqual([
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        description: "Frontier model",
        visibility: "list",
        supportedInApi: true,
        defaultReasoningLevel: "medium",
        supportedReasoningLevels: ["low", "medium", "high"],
        serviceTiers: ["priority"],
      },
      {
        id: "hidden-review",
        name: "Hidden Review",
        visibility: "hide",
      },
    ]);
  });

  it("drops malformed entries", () => {
    expect(parseCodexModelsCatalog({ models: [{ display_name: "No slug" }, null, { slug: "" }] })).toEqual([]);
  });
});

describe("codexCatalogWarning", () => {
  const live = {
    source: "live" as const,
    models: [
      { id: "gpt-5.4", name: "GPT-5.4", visibility: "list" as const },
      { id: "hidden", name: "H", visibility: "hide" as const },
    ],
  };

  it("warns when an explicit model is missing from a live catalog", () => {
    const warning = codexCatalogWarning("gpt-5.5", live);
    expect(warning).toContain('"gpt-5.5" is not in the model catalog');
    expect(warning).toContain("list_codex_models");
  });

  it("stays quiet for listed and hidden models, no model, a fallback catalog, or no catalog", () => {
    expect(codexCatalogWarning("gpt-5.4", live)).toBeNull();
    expect(codexCatalogWarning("hidden", live)).toBeNull();
    expect(codexCatalogWarning(undefined, live)).toBeNull();
    expect(codexCatalogWarning("gpt-5.5", { ...live, source: "fallback" })).toBeNull();
    expect(codexCatalogWarning("gpt-5.5", null)).toBeNull();
  });
});
