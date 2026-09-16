import { describe, expect, it } from "vitest";
import { ChatViewRegistry, VIEW_TTL, chatViewSchema } from "./chat-view.js";
import { DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS } from "shared/types/chat-filters.js";
const a = "00000000-0000-4000-8000-000000000001",
  b = "00000000-0000-4000-8000-000000000002";
const snapshot = (viewId = a, revision = 1) => ({
  viewId,
  revision,
  filters: structuredClone(DEFAULT_CHAT_FILTERS),
  options: { ...DEFAULT_CHAT_VIEW_OPTIONS },
  submittedSearch: "",
});
describe("originating tab registry", () => {
  it("isolates sessions and tabs, and never falls back to the last publisher", () => {
    const registry = new ChatViewRegistry((owner) => ["one", "two"].includes(owner));
    const first = registry.publish("one", snapshot());
    registry.publish("two", { ...snapshot(), submittedSearch: "private" });
    registry.publish("one", { ...snapshot(b), submittedSearch: "other tab" });
    expect(registry.read(first)).toMatchObject({ available: true, submittedSearch: "" });
    expect(registry.read()).toMatchObject({ available: false });
    expect(registry.read({ owner: "three", viewId: a })).toMatchObject({ available: false });
    expect(() => registry.publish(undefined, snapshot())).toThrow();
  });
  it("initial snapshot closes the first tool race and late revisions cannot replace newer filters", () => {
    const registry = new ChatViewRegistry(() => true);
    const binding = registry.publish("one", snapshot());
    registry.publish("one", { ...snapshot(a, 3), submittedSearch: "new" });
    registry.publish("one", { ...snapshot(a, 2), submittedSearch: "old" });
    expect(registry.read(binding)).toMatchObject({ revision: 3, submittedSearch: "new" });
    expect(() => registry.publish("one", snapshot(a, 3))).toThrow("Conflicting");
  });
  it("heartbeats retain revision and update timestamp but expire without renewal or after logout", () => {
    let now = 1000,
      valid = true;
    const registry = new ChatViewRegistry(
      () => valid,
      () => now,
    );
    const binding = registry.publish("one", snapshot());
    now += 20_000;
    registry.publish("one", snapshot());
    expect(registry.read(binding)).toMatchObject({ updatedAt: new Date(1000).toISOString() });
    now += VIEW_TTL + 1;
    expect(registry.read(binding)).toMatchObject({ available: false });
    registry.publish("one", snapshot(a, 2));
    valid = false;
    expect(registry.read(binding)).toMatchObject({ available: false });
  });
  it("retains revision tombstones so delayed packets cannot revive expired filters", () => {
    let now = 1000;
    const registry = new ChatViewRegistry(
      () => true,
      () => now,
    );
    const binding = registry.publish("one", snapshot(a, 5));
    now += VIEW_TTL + 1;
    registry.cleanup();
    registry.publish("one", snapshot(a, 4));
    registry.publish("one", snapshot(a, 5));
    expect(registry.read(binding)).toMatchObject({ available: false });
    registry.publish("one", snapshot(a, 6));
    expect(registry.read(binding)).toMatchObject({ available: true, revision: 6 });
  });
  it("deactivation fences late publications without closing a newer remount", () => {
    const registry = new ChatViewRegistry(() => true);
    const binding = registry.publish("one", snapshot(a, 1));
    registry.deactivate("one", { viewId: a, revision: 2 });
    registry.publish("one", snapshot(a, 1));
    expect(registry.read(binding)).toMatchObject({ available: false });
    registry.publish("one", snapshot(a, 3));
    registry.deactivate("one", { viewId: a, revision: 2 });
    expect(registry.read(binding)).toMatchObject({ available: true, revision: 3 });
    registry.deactivate("two", { viewId: a, revision: 100 });
    expect(registry.read(binding)).toMatchObject({ available: true, revision: 3 });
  });
  it("requires timezone-qualified active dates", () => {
    const s = snapshot();
    s.filters.dateMin = { active: true, value: "2026-09-16T12:00" };
    expect(chatViewSchema.safeParse(s).success).toBe(false);
    s.filters.dateMin.value += "-04:00";
    expect(chatViewSchema.safeParse(s).success).toBe(true);
  });
});
