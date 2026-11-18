import { describe, it, expect, expectTypeOf } from "vitest";
import { isRetiredProviderId, RETIRED_PROVIDERS } from "./retiredProviders";

describe("retiredProviders", () => {
  it.each(["openrouter", "cline"] as const)("names %s as retired", (id) => {
    expect(isRetiredProviderId(id)).toBe(true);
    expect(RETIRED_PROVIDERS[id]).toBeDefined();
  });

  it.each([null, undefined, "", "claude-code", "codex", "acp", "pi", "something-new", "toString", "__proto__"])("does not name %s as retired", (id) => {
    expect(isRetiredProviderId(id)).toBe(false);
  });

  // Type-level: checked by `tsc -p frontend`. The false branch must keep the
  // caller's own type rather than collapsing to `never` / `null`.
  it("narrows only the retired ids, leaving the false branch's type intact", () => {
    const live = "codex" as "codex" | "pi" | "claude-code";
    if (!isRetiredProviderId(live)) expectTypeOf(live).toEqualTypeOf<"codex" | "pi" | "claude-code">();
    const raw = "cline" as string | null;
    if (isRetiredProviderId(raw)) expectTypeOf(raw).toEqualTypeOf<"openrouter" | "cline">();
    else expectTypeOf(raw).toEqualTypeOf<string | null>();
  });

  it("tags Cline as CL", () => {
    expect(RETIRED_PROVIDERS.cline).toEqual({ tag: "CL", label: "Cline" });
  });
});
