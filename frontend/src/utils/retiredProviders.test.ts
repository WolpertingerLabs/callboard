import { describe, it, expect } from "vitest";
import { isRetiredProviderId, RETIRED_PROVIDERS } from "./retiredProviders";

describe("retiredProviders", () => {
  it.each(["openrouter", "cline"])("names %s as retired", (id) => {
    expect(isRetiredProviderId(id)).toBe(true);
    expect(RETIRED_PROVIDERS[id]).toBeDefined();
  });

  it.each([null, undefined, "", "claude-code", "codex", "acp", "pi", "something-new", "toString", "__proto__"])("does not name %s as retired", (id) => {
    expect(isRetiredProviderId(id)).toBe(false);
  });

  it("tags Cline as CL", () => {
    expect(RETIRED_PROVIDERS.cline).toEqual({ tag: "CL", label: "Cline" });
  });
});
