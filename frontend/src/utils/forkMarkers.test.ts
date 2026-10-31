import { describe, expect, it } from "vitest";
import type { ChatTreeNode, ChatTreeResponse, ParsedMessage } from "../api";
import { assignForkMarkers, forksByTimestamp } from "./forkMarkers";
import { groupToolMessages } from "./toolGrouping";

const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";

function node(chatId: string, overrides: Partial<ChatTreeNode> = {}): ChatTreeNode {
  return {
    chatId,
    title: chatId,
    provider: "claude-code",
    status: "stopped",
    folder: "/repo",
    createdAt: T1,
    updatedAt: T1,
    children: [],
    ...overrides,
  };
}

function tree(root: ChatTreeNode, target = root.chatId): ChatTreeResponse {
  return { targetChatId: target, rootChatId: root.chatId, ancestors: [], tree: root };
}

const text = (content: string, timestamp: string, overrides: Partial<ParsedMessage> = {}) =>
  ({ role: "assistant", type: "text", content, timestamp, ...overrides }) as ParsedMessage;

describe("forksByTimestamp", () => {
  it("groups the chat's direct forks and engine switches by fork point", () => {
    const f1 = node("f1", { role: "fork", forkedAt: T1 });
    const f2 = node("f2", { role: "engine-switch", forkedAt: T1 });
    const f3 = node("f3", { role: "fork", forkedAt: T2 });
    const map = forksByTimestamp(tree(node("me", { children: [f1, f2, f3] })));
    expect(map.get(T1)).toEqual([f1, f2]);
    expect(map.get(T2)).toEqual([f3]);
  });

  it("finds the target chat anywhere in the tree, and ignores grandchildren", () => {
    const grandchild = node("gc", { role: "fork", forkedAt: T2 });
    const mine = node("f1", { role: "fork", forkedAt: T1, children: [grandchild] });
    const root = node("root", { children: [node("me", { role: "subagent", children: [mine] })] });
    const map = forksByTimestamp(tree(root, "me"));
    expect([...map.keys()]).toEqual([T1]);
  });

  it("reads the chat from targetChatId, so a route carrying a session id keeps its markers", () => {
    // The server resolves /chats/<session-id>/tree to the chat and reports its
    // real id as the target; the route param never appears in the tree.
    const f1 = node("f1", { role: "fork", forkedAt: T1 });
    const root = node("root", { children: [node("me", { children: [f1] }), node("sibling", { children: [node("x", { role: "fork", forkedAt: T2 })] })] });
    expect(forksByTimestamp(tree(root, "me")).get(T1)).toEqual([f1]);
    expect(forksByTimestamp(tree(root, "me")).has(T2)).toBe(false);
  });

  it("skips legacy forks without forkedAt and children that are not forks", () => {
    const root = node("me", {
      children: [node("legacy", { role: "fork" }), node("sub", { role: "subagent", forkedAt: T1 }), node("plain", { forkedAt: T1 })],
    });
    expect(forksByTimestamp(tree(root)).size).toBe(0);
  });

  it("is empty without a tree", () => {
    expect(forksByTimestamp(null).size).toBe(0);
  });
});

describe("assignForkMarkers", () => {
  const forks = [node("f1", { role: "fork", forkedAt: T1 })];

  it("puts the marker on the LAST bubble sharing the fork point's timestamp", () => {
    const items = groupToolMessages([text("a", T1), text("b", T1), text("c", T1), text("d", T2)]);
    const markers = assignForkMarkers(items, new Map([[T1, forks]]));
    expect([...markers.entries()]).toEqual([[2, forks]]);
    // The same array the tree map holds — identity-stable for the memoized bubble.
    expect(markers.get(2)).toBe(forks);
  });

  it("skips same-timestamp items that render no bubble for the chip", () => {
    const items = groupToolMessages([
      text("a", T1),
      { role: "assistant", type: "thinking", content: "", timestamp: T1 } as ParsedMessage,
      text("team", T1, { teamName: "reviewer" }),
      { role: "assistant", type: "tool_use", toolName: "Bash", toolUseId: "t1", content: "{}", timestamp: T1 } as ParsedMessage,
    ]);
    expect([...assignForkMarkers(items, new Map([[T1, forks]])).keys()]).toEqual([0]);
  });

  it("marks nothing when no message matches the fork point", () => {
    expect(assignForkMarkers(groupToolMessages([text("a", T2)]), new Map([[T1, forks]])).size).toBe(0);
  });
});
