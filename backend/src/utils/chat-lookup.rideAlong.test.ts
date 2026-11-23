/**
 * Every transcript reader goes through readChatSessionMessages — the chat view,
 * rerun, seeded forks and compression, read_session_messages — so the
 * ride-along block is split off there, once, for all of them and every engine.
 */
import { expect, it, vi } from "vitest";
import { actionWithdrawnNotice, formatRideAlongBlock, CALLBOARD_NOTICE_SUBTYPE, type ParsedMessage } from "shared/types/index.js";

const parsed = vi.hoisted(() => ({ messages: [] as ParsedMessage[] }));
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [{ kind: "claude-code", parseSessionMessages: () => parsed.messages }],
}));

const { readChatSessionMessages } = await import("./chat-lookup.js");

it("serves a prefixed human message as a notice row plus the human's own text", () => {
  const block = formatRideAlongBlock([actionWithdrawnNotice("click", "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b", "stopped")]);
  parsed.messages = [{ role: "user", type: "text", content: `${block}\n\nhello`, timestamp: "t1" }];
  expect(readChatSessionMessages({ metadata: "{}", session_id: "s1" })).toEqual([
    expect.objectContaining({ role: "system", subtype: CALLBOARD_NOTICE_SUBTYPE }),
    expect.objectContaining({ role: "user", content: "hello" }),
  ]);
});
