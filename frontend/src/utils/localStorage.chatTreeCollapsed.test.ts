// @vitest-environment jsdom
/**
 * Collapsed nodes inside the sidebar's expanded chat trees. Only collapsed ids
 * are stored, so absence is "expanded" — the default the user asked for.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_TREE_CARDS_EXPANDED_KEY,
  CHAT_TREE_COLLAPSED_KEY,
  CHAT_TREE_COLLAPSED_MAX,
  getChatTreeCardExpandedKeys,
  getChatTreeCollapsedIds,
  saveChatTreeCardExpanded,
  saveChatTreeNodeCollapsed,
} from "./localStorage";

const SETTINGS_KEY = "claude-code-settings";

beforeEach(() => localStorage.clear());

describe("chat tree collapsed ids", () => {
  it("is empty by default — every node expanded", () => {
    expect(getChatTreeCollapsedIds().size).toBe(0);
  });

  it("round-trips a collapse and removes the key once nothing is collapsed", () => {
    saveChatTreeNodeCollapsed("a", true);
    saveChatTreeNodeCollapsed("b", true);
    expect([...getChatTreeCollapsedIds()].sort()).toEqual(["a", "b"]);
    saveChatTreeNodeCollapsed("a", false);
    expect([...getChatTreeCollapsedIds()]).toEqual(["b"]);
    saveChatTreeNodeCollapsed("b", false);
    expect(localStorage.getItem(CHAT_TREE_COLLAPSED_KEY)).toBeNull();
  });

  it("expanding a node that was never collapsed writes nothing", () => {
    saveChatTreeNodeCollapsed("a", false);
    expect(localStorage.getItem(CHAT_TREE_COLLAPSED_KEY)).toBeNull();
  });

  it("never expires a fold by age — only the count cap evicts", () => {
    const now = 1_000_000_000_000;
    const yearAgo = now - 365 * 24 * 60 * 60 * 1000;
    saveChatTreeNodeCollapsed("old", true, yearAgo);
    saveChatTreeNodeCollapsed("fresh", true, now);
    expect([...getChatTreeCollapsedIds()].sort()).toEqual(["fresh", "old"]);
  });

  it("keeps at most the newest MAX, dropping the oldest first", () => {
    const now = 1_000_000_000_000;
    for (let i = 0; i <= CHAT_TREE_COLLAPSED_MAX; i++) saveChatTreeNodeCollapsed(`c${i}`, true, now + i);
    const ids = getChatTreeCollapsedIds();
    expect(ids.size).toBe(CHAT_TREE_COLLAPSED_MAX);
    expect(ids.has("c0")).toBe(false);
    expect(ids.has(`c${CHAT_TREE_COLLAPSED_MAX}`)).toBe(true);
  });

  it("ignores malformed storage and malformed entries", () => {
    localStorage.setItem(CHAT_TREE_COLLAPSED_KEY, "{not json");
    expect(getChatTreeCollapsedIds().size).toBe(0);
    localStorage.setItem(CHAT_TREE_COLLAPSED_KEY, JSON.stringify(["a"]));
    expect(getChatTreeCollapsedIds().size).toBe(0);
    localStorage.setItem(CHAT_TREE_COLLAPSED_KEY, JSON.stringify({ good: 1, bad: "x", worse: null }));
    expect([...getChatTreeCollapsedIds()]).toEqual(["good"]);
  });

  it("leaves the settings blob untouched", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme: "dark" }));
    saveChatTreeNodeCollapsed("a", true);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toEqual({ theme: "dark" });
  });
});

describe("chat tree cards opened", () => {
  it("defaults to every card closed, and clears its key once nothing is open", () => {
    expect(getChatTreeCardExpandedKeys().size).toBe(0);
    saveChatTreeCardExpanded("root", true);
    expect([...getChatTreeCardExpandedKeys()]).toEqual(["root"]);
    saveChatTreeCardExpanded("root", false);
    expect(localStorage.getItem(CHAT_TREE_CARDS_EXPANDED_KEY)).toBeNull();
  });

  it("is a separate record from the node folds, so one root id can be in either without the other", () => {
    saveChatTreeCardExpanded("root", true);
    expect(getChatTreeCollapsedIds().has("root")).toBe(false);
    saveChatTreeNodeCollapsed("root", true);
    saveChatTreeCardExpanded("root", false);
    expect(getChatTreeCollapsedIds().has("root")).toBe(true);
    expect(getChatTreeCardExpandedKeys().has("root")).toBe(false);
  });

  it("is bounded like the node folds, the least recently opened going first", () => {
    const now = Date.now();
    for (let i = 0; i <= CHAT_TREE_COLLAPSED_MAX; i++) saveChatTreeCardExpanded(`k${i}`, true, now + i);
    const keys = getChatTreeCardExpandedKeys();
    expect(keys.size).toBe(CHAT_TREE_COLLAPSED_MAX);
    expect(keys.has("k0")).toBe(false);
    expect(keys.has(`k${CHAT_TREE_COLLAPSED_MAX}`)).toBe(true);
  });

  it("drops the legacy folded-cards record on read, and does not read it as anything", () => {
    localStorage.setItem("callboard-chat-tree-cards-collapsed", JSON.stringify({ root: 1 }));
    expect(getChatTreeCardExpandedKeys().size).toBe(0);
    expect(localStorage.getItem("callboard-chat-tree-cards-collapsed")).toBeNull();
  });
});
