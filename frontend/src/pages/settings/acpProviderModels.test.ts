import { describe, it, expect } from "vitest";
import { mergeAcpProviderModel } from "./acpProviderModels";

/**
 * The frontend half of the ACP per-vendor default model. The backend half —
 * blank values dropped, an emptied map collapsed to `undefined`, bad shapes
 * rejected — is covered by `backend/src/routes/agent-settings.partial-update.test.ts`;
 * what is only decidable on this side is *which* map gets sent, since the page
 * edits one vendor's field but has to PUT the whole map.
 */
describe("mergeAcpProviderModel", () => {
  it("writes the edited vendor's entry into an absent map", () => {
    expect(mergeAcpProviderModel(undefined, "opencode", "opencode/gpt-5.5")).toEqual({ opencode: "opencode/gpt-5.5" });
  });

  it("keeps every other vendor's entry when saving from one vendor's tab", () => {
    const existing = { opencode: "opencode/gpt-5.5", "other-vendor": "other/model-1" };
    expect(mergeAcpProviderModel(existing, "opencode", "opencode/mimo-v2.5-free")).toEqual({
      opencode: "opencode/mimo-v2.5-free",
      "other-vendor": "other/model-1",
    });
  });

  it("does not mutate the map it was handed", () => {
    const existing = { opencode: "opencode/gpt-5.5" };
    mergeAcpProviderModel(existing, "opencode", "opencode/mimo-v2.5-free");
    expect(existing).toEqual({ opencode: "opencode/gpt-5.5" });
  });

  it("trims the edited value, so a whitespace-only edit reaches the backend as a blank to drop", () => {
    expect(mergeAcpProviderModel(undefined, "opencode", "  opencode/gpt-5.5  ")).toEqual({ opencode: "opencode/gpt-5.5" });
    expect(mergeAcpProviderModel({ opencode: "opencode/gpt-5.5" }, "opencode", "   ")).toEqual({ opencode: "" });
  });

  it("sends a cleared entry as an empty string rather than deleting it client-side", () => {
    // The backend normalizer is the single place that decides a blank row is a
    // clear; duplicating that here would give the two rules somewhere to drift.
    expect(mergeAcpProviderModel({ opencode: "opencode/gpt-5.5", "other-vendor": "other/model-1" }, "opencode", "")).toEqual({
      opencode: "",
      "other-vendor": "other/model-1",
    });
  });

  it("passes the map through untouched when the vendor id has not resolved", () => {
    const existing = { opencode: "opencode/gpt-5.5" };
    expect(mergeAcpProviderModel(existing, "", "something")).toBe(existing);
    // ...including when there is no map to pass through, so the PUT carries
    // `undefined` and the settings route leaves the stored field alone.
    expect(mergeAcpProviderModel(undefined, "", "something")).toBeUndefined();
  });
});
