import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  lookup: vi.fn(() => null),
  listener: undefined as undefined | ((event: { event: string; chatId: string; type: string }) => void),
  chat: { id: "watcher", session_id: "duplicate", metadata: '{"provider":"acp","acpProviderId":"opencode"}' },
}));
vi.mock("../utils/session-log.js", () => ({ findSessionLogPath: state.lookup }));
vi.mock("./chat-file-service.js", () => ({ chatFileService: { getAllChats: () => [state.chat], getChat: () => state.chat } }));
vi.mock("./session-registry.js", () => ({
  sessionRegistry: {
    get: () => undefined,
    on: (_: string, listener: typeof state.listener) => {
      state.listener = listener;
    },
    off: () => {
      state.listener = undefined;
    },
  },
}));
const { initCliWatcher, shutdownCliWatcher } = await import("./cli-watcher.js");

afterEach(() => {
  shutdownCliWatcher();
  vi.useRealTimers();
});

it("forwards authoritative routing in both scan and stopped-web-session preseed paths", async () => {
  vi.useFakeTimers();
  initCliWatcher();
  await Promise.resolve();
  expect(state.lookup).toHaveBeenCalledWith("duplicate", state.chat.metadata);
  state.lookup.mockClear();
  expect(() => state.listener!({ event: "session_stopped", chatId: "watcher", type: "web" })).not.toThrow();
  expect(state.lookup).toHaveBeenCalledWith("duplicate", state.chat.metadata);
});
