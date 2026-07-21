import { describe, it, expect } from "vitest";
import { validateModelAliases } from "shared";

describe("validateModelAliases", () => {
  it("accepts a well-formed registry and normalizes targets", () => {
    const { value, errors } = validateModelAliases([
      { name: "planner", description: "big brain", targets: { "claude-code": "opus", openrouter: "anthropic/claude-opus-4.8", codex: "gpt-5.5" } },
      { name: "worker", targets: { openrouter: "moonshotai/kimi-k2" } },
    ]);
    expect(errors).toEqual([]);
    expect(value).toHaveLength(2);
    expect(value[0]).toEqual({
      name: "planner",
      description: "big brain",
      targets: { "claude-code": "opus", openrouter: "anthropic/claude-opus-4.8", codex: "gpt-5.5" },
    });
  });

  it("errors when input is not an array", () => {
    expect(validateModelAliases({} as unknown).errors[0]).toMatch(/must be an array/);
  });

  it("drops nameless rows and aliases with no valid target", () => {
    const { value, errors } = validateModelAliases([
      { name: "", targets: { codex: "gpt-5.5" } },
      { name: "empty", targets: { openrouter: "  " } },
      { name: "keep", targets: { codex: "gpt-5.5" } },
    ]);
    expect(errors).toEqual([]);
    expect(value.map((a) => a.name)).toEqual(["keep"]);
  });

  it("rejects duplicate names case-insensitively", () => {
    const { errors } = validateModelAliases([
      { name: "Planner", targets: { codex: "gpt-5.5" } },
      { name: "planner", targets: { openrouter: "x/y" } },
    ]);
    expect(errors.some((e) => /Duplicate alias name/.test(e))).toBe(true);
  });

  it("rejects unknown provider targets", () => {
    const { errors } = validateModelAliases([{ name: "x", targets: { gemini: "g" } }]);
    expect(errors.some((e) => /unknown provider target/.test(e))).toBe(true);
  });

  it("rejects a target that names another alias (one-hop)", () => {
    const { errors } = validateModelAliases([
      { name: "planner", targets: { openrouter: "worker" } },
      { name: "worker", targets: { openrouter: "moonshotai/kimi-k2" } },
    ]);
    expect(errors.some((e) => /points to another alias/.test(e))).toBe(true);
  });

  it("trims description and drops it when blank", () => {
    const { value } = validateModelAliases([{ name: "x", description: "  ", targets: { codex: "gpt-5.5" } }]);
    expect(value[0].description).toBeUndefined();
  });
});
