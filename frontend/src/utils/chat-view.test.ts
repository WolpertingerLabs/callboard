import { afterEach, describe, expect, it, vi } from "vitest";
import { publishChatView, originatingChatView, stopChatViewPublisher } from "./chat-view.js";
import { DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS, filterChatRows } from "shared/types/chat-filters.js";
afterEach(() => {
  stopChatViewPublisher();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("tab publisher", () => {
  it("publishes submitted state, absolute local dates and live revisions, not editable drafts", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const filters = structuredClone(DEFAULT_CHAT_FILTERS);
    filters.dateMin = { active: true, value: "2026-09-16T12:30" };
    publishChatView(filters, DEFAULT_CHAT_VIEW_OPTIONS, " submitted ");
    const first = originatingChatView()!;
    expect(first.filters.dateMin.value).toBe(new Date(filters.dateMin.value).toISOString());
    expect(first.submittedSearch).toBe("submitted");
    filters.dateMin.value = "draft";
    expect(originatingChatView()!.filters.dateMin.value).toBe(first.filters.dateMin.value);
    publishChatView(DEFAULT_CHAT_FILTERS, { ...DEFAULT_CHAT_VIEW_OPTIONS, bookmarked: true }, "next");
    expect(originatingChatView()).toMatchObject({ viewId: first.viewId, revision: first.revision + 3, options: { bookmarked: true } });
  });
  it("renews on heartbeat and clears unavailable state on unmount", () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    publishChatView(DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS, "");
    vi.advanceTimersByTime(25_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    stopChatViewPublisher();
    expect(originatingChatView()).toBeUndefined();
  });
  it("uses display-folder regex and inclusive updated-time bounds; invalid regex is disclosed", () => {
    const filters = structuredClone(DEFAULT_CHAT_FILTERS);
    filters.directoryInclude = { active: true, value: "REPO" };
    filters.dateMin = { active: true, value: "2026-09-16T16:00:00Z" };
    const rows = [{ folder: "/worktree", displayFolder: "/repo", updated_at: "2026-09-16T12:00:00-04:00" }];
    expect(filterChatRows(rows, filters).rows).toEqual(rows);
    filters.directoryInclude.value = "[";
    expect(filterChatRows(rows, filters).warnings).toHaveLength(1);
  });
});

it("captures fresh foreground revisions after suspension without changing delayed packets", () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  publishChatView(DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS, "needle");
  const delayed = originatingChatView()!;
  const fresh = originatingChatView()!;
  expect(fresh.revision).toBeGreaterThan(delayed.revision);
  expect(delayed.revision).toBe(fresh.revision - 1);
  expect(fresh.submittedSearch).toBe("needle");
});
it.each([true, false])("does not attach oversized accepted sidebar state to normal messages (active=%s)", (active) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  publishChatView(DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS, "");
  const filters = structuredClone(DEFAULT_CHAT_FILTERS);
  filters.directoryInclude = { active, value: "x".repeat(1001) };
  const report = vi.fn();
  publishChatView(filters, DEFAULT_CHAT_VIEW_OPTIONS, "", report);
  expect(report).toHaveBeenCalledWith(expect.stringContaining("1000"));
  expect(JSON.stringify({ prompt: "hello", chatView: originatingChatView() })).toBe('{"prompt":"hello"}');
});
it("discloses rejected publication and drops only that unusable snapshot", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const report = vi.fn();
  publishChatView(DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS, "", report);
  await Promise.resolve();
  expect(originatingChatView()).toBeUndefined();
  expect(report).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
});
it("a late rejection cannot clear a newer view", async () => {
  let reject!: (response: { ok: boolean }) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            reject = resolve;
          }),
      )
      .mockResolvedValue({ ok: true }),
  );
  publishChatView(DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS, "old");
  publishChatView(DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS, "new");
  reject({ ok: false });
  await Promise.resolve();
  expect(originatingChatView()?.submittedSearch).toBe("new");
});
