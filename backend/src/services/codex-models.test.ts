import { describe, expect, it } from "vitest";
import { parseCodexModelsCatalog } from "./codex-models.js";

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
