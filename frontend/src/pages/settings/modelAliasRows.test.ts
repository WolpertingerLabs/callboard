import { describe, it, expect } from "vitest";
import { validateModelAliases, type ModelAlias } from "shared/types/index.js";
import { toRows, toAliases, hasEditableTarget, hasRetiredTarget, onlyRetiredTargets, type AliasRow } from "./modelAliasRows";

/**
 * The alias editor rebuilds `targets` from row state on every save, so a target
 * the row does not carry is a target the next save deletes. That is survivable
 * for a column the user can see and retype; it is not for `openrouter`, which
 * has had no column since the harness was removed and whose only backup — the
 * legacy `openRouterModelAliases` map — is retired by the very same request
 * (see `routes/agent-settings.ts`). One forgotten field silently destroys user
 * data with no way to notice or recover, which is what these tests exist to
 * catch.
 */

/** The round trip a save performs: server aliases → rows → edit → back. */
const roundTrip = (aliases: ModelAlias[], edit: (r: AliasRow) => AliasRow = (r) => r) => toAliases(toRows(aliases).map(edit));

describe("alias row round-trip", () => {
  it("preserves a retired openrouter target when another column is edited", () => {
    const stored: ModelAlias[] = [{ name: "planner", targets: { "claude-code": "opus", openrouter: "anthropic/claude-opus-4.8" } }];

    const saved = roundTrip(stored, (r) => ({ ...r, codex: "gpt-5.5" }));

    expect(saved).toEqual([{ name: "planner", targets: { "claude-code": "opus", openrouter: "anthropic/claude-opus-4.8", codex: "gpt-5.5" } }]);
  });

  it("keeps an alias whose only target is the retired slug", () => {
    const stored: ModelAlias[] = [{ name: "legacy", description: "from the OR era", targets: { openrouter: "moonshotai/kimi-k2" } }];

    expect(roundTrip(stored)).toEqual(stored);
  });

  it("survives repeated saves without drift", () => {
    const stored: ModelAlias[] = [{ name: "worker", targets: { openrouter: "moonshotai/kimi-k2", pi: "google/gemini-3.6-flash" } }];

    expect(roundTrip(roundTrip(roundTrip(stored)))).toEqual(stored);
  });

  it("clears the target only when the row explicitly blanks it", () => {
    const stored: ModelAlias[] = [{ name: "planner", targets: { "claude-code": "opus", openrouter: "anthropic/claude-opus-4.8" } }];

    // What the note's "Clear it" button does.
    expect(roundTrip(stored, (r) => ({ ...r, openrouter: "" }))).toEqual([{ name: "planner", targets: { "claude-code": "opus" } }]);
  });

  it("drops an alias left with no target at all", () => {
    const stored: ModelAlias[] = [{ name: "legacy", targets: { openrouter: "moonshotai/kimi-k2" } }];

    expect(roundTrip(stored, (r) => ({ ...r, openrouter: "" }))).toEqual([]);
  });

  it("emits aliases the shared validator accepts unchanged", () => {
    // The page runs this validator live and disables Save on any error, so a
    // legacy target must not merely survive — it must stay valid.
    const stored: ModelAlias[] = [
      { name: "planner", targets: { "claude-code": "opus", openrouter: "anthropic/claude-opus-4.8" } },
      { name: "legacy", targets: { openrouter: "moonshotai/kimi-k2" } },
    ];

    const { value, errors } = validateModelAliases(roundTrip(stored));

    expect(errors).toEqual([]);
    expect(value).toEqual(stored);
  });
});

describe("retired cline target round-trip", () => {
  it("preserves a retired cline target when another column is edited", () => {
    const stored: ModelAlias[] = [{ name: "worker", targets: { pi: "google/gemini-3.6-flash", cline: "claude-sonnet-4-6" } }];

    const saved = roundTrip(stored, (r) => ({ ...r, codex: "gpt-5.5" }));

    expect(saved).toEqual([{ name: "worker", targets: { pi: "google/gemini-3.6-flash", cline: "claude-sonnet-4-6", codex: "gpt-5.5" } }]);
  });

  it("keeps an alias whose only target is a retired cline id, and it validates", () => {
    const stored: ModelAlias[] = [{ name: "legacy-cline", targets: { cline: "claude-sonnet-4-6" } }];

    const { value, errors } = validateModelAliases(roundTrip(stored));

    expect(errors).toEqual([]);
    expect(value).toEqual(stored);
  });
});

describe("retired acp target round-trip", () => {
  it("preserves a retired acp target when another column is edited", () => {
    const stored: ModelAlias[] = [{ name: "worker", targets: { pi: "google/gemini-3.6-flash", acp: "opencode/gpt-5.5" } }];

    const saved = roundTrip(stored, (r) => ({ ...r, codex: "gpt-5.5" }));

    expect(saved).toEqual([{ name: "worker", targets: { pi: "google/gemini-3.6-flash", acp: "opencode/gpt-5.5", codex: "gpt-5.5" } }]);
  });

  it("keeps an alias whose only target is a retired acp id, and it validates", () => {
    const stored: ModelAlias[] = [{ name: "legacy-opencode", targets: { acp: "opencode/gpt-5.5" } }];

    const { value, errors } = validateModelAliases(roundTrip(stored));

    expect(errors).toEqual([]);
    expect(value).toEqual(stored);
  });
});

describe("legacy-note gating", () => {
  const row = (over: Partial<AliasRow> = {}): AliasRow => ({
    name: "a",
    description: "",
    claudeCode: "",
    openrouter: "",
    codex: "",
    acp: "",
    cline: "",
    pi: "",
    ...over,
  });

  it("treats a row configured for a live harness as having an editable target", () => {
    expect(hasEditableTarget(row({ codex: "gpt-5.5" }))).toBe(true);
    expect(hasEditableTarget(row({ openrouter: "moonshotai/kimi-k2" }))).toBe(false);
  });

  it("only advises setting a target when the retired slug is the sole one", () => {
    expect(onlyRetiredTargets(row({ openrouter: "moonshotai/kimi-k2" }))).toBe(true);
    // The common case after migration: already configured elsewhere, so the
    // advice to go set a target would be telling the user to redo their work.
    expect(onlyRetiredTargets(row({ openrouter: "moonshotai/kimi-k2", claudeCode: "opus" }))).toBe(false);
    expect(onlyRetiredTargets(row())).toBe(false);
  });

  it("has no column for a retired cline target, and flags it as the sole target", () => {
    const clineOnly = row({ cline: "claude-sonnet-4-6" });
    expect(hasEditableTarget(clineOnly)).toBe(false);
    expect(hasRetiredTarget(clineOnly)).toBe(true);
    expect(onlyRetiredTargets(clineOnly)).toBe(true);
    expect(onlyRetiredTargets(row({ cline: "x", openrouter: "y" }))).toBe(true);
    expect(onlyRetiredTargets(row({ cline: "x", pi: "google/gemini-3.6-flash" }))).toBe(false);
    expect(hasRetiredTarget(row({ pi: "p" }))).toBe(false);
  });

  it("has no column for a retired acp target, and flags it as the sole target", () => {
    const acpOnly = row({ acp: "opencode/gpt-5.5" });
    expect(hasEditableTarget(acpOnly)).toBe(false);
    expect(hasRetiredTarget(acpOnly)).toBe(true);
    expect(onlyRetiredTargets(acpOnly)).toBe(true);
    expect(onlyRetiredTargets(row({ acp: "x", codex: "gpt-5.5" }))).toBe(false);
  });
});
