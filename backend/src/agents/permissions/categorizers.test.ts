/**
 * Registry tests.
 *
 * The load-bearing guard is the type — `Record<AgentProviderKind, …>` makes a
 * missing entry a compile error, which `npm run build` catches. These tests
 * cover what the type cannot: that the recorded key set is the real union (a
 * `Record` cannot tell you a key was added to the union *and* the record but
 * never thought about), and that no kind silently inherits another provider's
 * map — the exact defect the registry replaced.
 */
import { describe, it, expect } from "vitest";
import { TOOL_CATEGORIZERS, getToolCategorizer } from "./categorizers.js";
import type { AgentProviderKind } from "../ports/AgentProvider.js";

/**
 * Every kind in the union, written out by hand.
 *
 * This list is the point of the test. Adding a kind to `AgentProviderKind`
 * without a categorizer fails to compile; adding it to both without deciding
 * what its permission story is fails HERE, because the author has to come add
 * the name and confront the assertions below.
 *
 * The `satisfies` clause makes the list itself type-checked: a name that is not
 * a real kind is a compile error, so this cannot drift into fiction.
 */
const ALL_KINDS = ["claude-code", "codex", "pi", "mock"] as const satisfies readonly AgentProviderKind[];

/**
 * Compile-time completeness for {@link ALL_KINDS}.
 *
 * `satisfies` above proves every listed name IS a kind; it does not prove every
 * kind is listed. This does: `UncoveredKind` is `never` exactly when the list
 * covers the union, and `never[]` is the only array type assignable to `never[]`.
 * Add `"newvendor"` to `AgentProviderKind` and this line stops compiling with
 * `Type '"newvendor"[]' is not assignable to type 'never[]'`.
 *
 * Two guards fire on a new kind, and they say different things. The `Record` in
 * `categorizers.ts` says "this kind has no categorizer". This one says "this
 * kind was never considered here" — it is what keeps the assertions below from
 * quietly covering four kinds out of six. `include: ["src"]` in
 * `backend/tsconfig.json` puts test files in the build, so `npm run build`
 * enforces it.
 */
type UncoveredKind = Exclude<AgentProviderKind, (typeof ALL_KINDS)[number]>;
const _allKindsAreListed: never[] = [] as UncoveredKind[];
void _allKindsAreListed;

describe("TOOL_CATEGORIZERS", () => {
  it("has an entry for every AgentProviderKind, and no extras", () => {
    expect(Object.keys(TOOL_CATEGORIZERS).sort()).toEqual([...ALL_KINDS].sort());
  });

  it("returns a usable categorizer for every kind", () => {
    for (const kind of ALL_KINDS) {
      const categorize = getToolCategorizer(kind);
      expect(typeof categorize, `${kind} has no categorizer`).toBe("function");
    }
  });

  it("routes pi through the name categorizer", () => {
    // The shared name tokenizer resolves an unknown, non-identifier label to
    // the strictest gate; Claude's map would have said fileWrite.
    expect(getToolCategorizer("pi")("Run `rm -rf` to clear the index")).toBe("codeExecution");
  });

  it("has no entry for the retired acp kind", () => {
    expect(Object.hasOwn(TOOL_CATEGORIZERS, "acp")).toBe(false);
  });

  /**
   * Codex has no per-call `canUseTool` hook, so this entry is unreachable
   * today. It exists to keep the record exhaustive, and it must not be another
   * provider's name map: if Codex ever grows a hook, the failure mode should be
   * "prompts too much", not "ran a tool nobody approved".
   */
  it("gates Codex and any future hookless provider at the strictest axis", () => {
    const codex = getToolCategorizer("codex");
    for (const name of ["shell", "apply_patch", "view_image", "anything_at_all"]) {
      expect(codex(name)).toBe("codeExecution");
    }
  });

});
