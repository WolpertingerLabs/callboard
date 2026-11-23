/**
 * Chat notices, delivered the way production delivers them: by the completion
 * handler, which sends a notice as a turn when the chat is idle and holds it
 * until the current turn ends when it is not.
 *
 * As in held-message-dispatcher.test.ts, a "turn" is an entry in `active` and a
 * stop is a `session_stopped` emit after removing it.
 */
import { beforeEach, expect, it, vi } from "vitest";

const active = vi.hoisted(() => new Set<string>());
const sent = vi.hoisted(() => [] as { chatId: string; prompt: string }[]);
const ready = vi.hoisted(() => new Map<string, { id: string; childChatId: string; depth: number; kind: "spawned" }[]>());
const existing = vi.hoisted(() => ({ chats: new Set<string>() }));
const archived = vi.hoisted(() => new Set<string>());
const failingSends = vi.hoisted(() => new Set<string>());

vi.mock("./chat-archived.js", () => ({ isChatArchived: (id: string) => archived.has(id) }));
vi.mock("./agent-executor.js", () => ({ executeAgent: vi.fn() }));
vi.mock("../utils/chat-lookup.js", () => ({ findChat: (id: string) => (existing.chats.has(id) ? { id } : undefined) }));
vi.mock("./session-callbacks.js", () => ({
  markChildComplete: () => [],
  getReadyForParent: (id: string) => ready.get(id) ?? [],
  removeCallbacks: (ids: string[]) => {
    for (const [parent, list] of ready)
      ready.set(
        parent,
        list.filter((c) => !ids.includes(c.id)),
      );
  },
  parentsWithReadyCallbacks: () => [...ready.entries()].filter(([, l]) => l.length > 0).map(([p]) => p),
  setChatDepth: () => {},
  clearChatDepth: () => {},
}));

const { sessionRegistry } = await import("./session-registry.js");
const { initSessionCompletionHandler, setIdleDeliveryHook } = await import("./session-completion-handler.js");
const { enqueueChatNotice, peekChatNotices, clearChatNoticesForTest, claimRideAlongNotices, prependToPrompt, RIDE_ALONG_HEADER, MAX_NOTICE_DELIVERY_ATTEMPTS } =
  await import("./chat-notices.js");
const { EventEmitter } = await import("events");

async function drain(iterable: AsyncIterable<{ message: { content: unknown } }>): Promise<string> {
  for await (const item of iterable) {
    const content = item.message.content;
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  return "";
}

initSessionCompletionHandler({
  sendMessage: async (opts) => {
    if (failingSends.has(opts.chatId!)) throw new Error("Chat cannot be resumed");
    sent.push({ chatId: opts.chatId!, prompt: await drain(opts.prompt as unknown as AsyncIterable<{ message: { content: unknown } }>) });
    active.add(opts.chatId!);
    return new EventEmitter();
  },
  getActiveSession: (id) => (active.has(id) ? {} : undefined),
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}
async function stop(chatId: string): Promise<void> {
  active.delete(chatId);
  sessionRegistry.emit("change", { event: "session_stopped", chatId, type: "web" });
  await settle();
}

beforeEach(() => {
  active.clear();
  sent.length = 0;
  ready.clear();
  existing.chats = new Set(["idle-chat", "busy-chat", "parent-chat", "archived-chat", "stuck-chat", "held-chat"]);
  archived.clear();
  failingSends.clear();
  setIdleDeliveryHook(null);
  clearChatNoticesForTest();
});

it("an idle chat gets the notice as a turn straight away", async () => {
  enqueueChatNotice("idle-chat", "The human approved your request.");
  await settle();
  expect(sent).toEqual([{ chatId: "idle-chat", prompt: "The human approved your request." }]);
  expect(peekChatNotices("idle-chat")).toEqual([]);
});

it("a busy chat gets it when its current turn ends, not before", async () => {
  active.add("busy-chat");
  enqueueChatNotice("busy-chat", "first");
  enqueueChatNotice("busy-chat", "second");
  await settle();
  expect(sent).toEqual([]);
  expect(peekChatNotices("busy-chat")).toHaveLength(2);
  await stop("busy-chat");
  // Both go out together, in order, as one turn.
  expect(sent).toHaveLength(1);
  expect(sent[0].prompt).toMatch(/first[\s\S]*second/);
  expect(peekChatNotices("busy-chat")).toEqual([]);
});

it("rides along with completion callbacks that are due at the same time", async () => {
  active.add("parent-chat");
  ready.set("parent-chat", [{ id: "cb1", childChatId: "child-1", depth: 1, kind: "spawned" }]);
  enqueueChatNotice("parent-chat", "Computer control update");
  await stop("parent-chat");
  expect(sent).toHaveLength(1);
  expect(sent[0].prompt).toContain("child-1");
  expect(sent[0].prompt).toContain("Computer control update");
});

it("a deleted chat's notices are dropped, not delivered elsewhere", async () => {
  existing.chats.delete("idle-chat");
  enqueueChatNotice("idle-chat", "gone");
  await settle();
  expect(sent).toEqual([]);
  expect(peekChatNotices("idle-chat")).toEqual([]);
});

it("an archived chat's notices are dropped, never sent — a send would un-archive it", async () => {
  archived.add("archived-chat");
  enqueueChatNotice("archived-chat", "The human approved your request.");
  await settle();
  expect(sent).toEqual([]);
  expect(peekChatNotices("archived-chat")).toEqual([]);
});

it("a ride-along notice never starts a turn; the next turn takes it, whoever starts it", async () => {
  enqueueChatNotice("idle-chat", "Your request was withdrawn: the human pressed Stop.", { wake: false });
  await settle();
  expect(sent).toEqual([]);
  // Busy chat stopping is not a reason to deliver it either.
  await stop("idle-chat");
  expect(sent).toEqual([]);
  // What sendMessage does at the start of any turn: claim, then commit once the engine has it.
  const claim = claimRideAlongNotices("idle-chat")!;
  expect(claim.text).toMatch(/^\[Callboard system notice — not typed by the human[\s\S]*the human pressed Stop[\s\S]*End of Callboard notice/);
  // Claimed is exclusive: a concurrent turn does not carry it too.
  expect(claimRideAlongNotices("idle-chat")).toBeNull();
  claim.commit();
  claim.release(); // no-op once committed
  expect(claimRideAlongNotices("idle-chat")).toBeNull();
});

it("a turn that never started puts its ride-along notices back, ahead of newer ones", () => {
  enqueueChatNotice("idle-chat", "first withdrawal", { wake: false });
  const claim = claimRideAlongNotices("idle-chat")!;
  enqueueChatNotice("idle-chat", "second withdrawal", { wake: false });
  claim.release();
  claim.commit(); // no-op once released
  const next = claimRideAlongNotices("idle-chat")!;
  expect(next.text.indexOf("first withdrawal")).toBeLessThan(next.text.indexOf("second withdrawal"));
});

it("prepends the block to a string prompt, and to the first user message of an iterable — text or multimodal", async () => {
  expect(prependToPrompt("hello", "BLOCK")).toBe("BLOCK\n\nhello");
  const collect = async (prompt: string | AsyncIterable<unknown>) => {
    const out: unknown[] = [];
    for await (const item of prompt as AsyncIterable<unknown>) out.push(item);
    return out;
  };
  const iterable = (async function* () {
    yield { type: "user", message: { role: "user", content: "from the user" } };
    yield { type: "user", message: { role: "user", content: "later" } };
  })();
  expect(await collect(prependToPrompt(iterable, "BLOCK"))).toEqual([
    { type: "user", message: { role: "user", content: "BLOCK\n\nfrom the user" } },
    { type: "user", message: { role: "user", content: "later" } },
  ]);
  const multimodal = (async function* () {
    yield { type: "user", message: { role: "user", content: [{ type: "image", source: {} }] } };
  })();
  expect(await collect(prependToPrompt(multimodal, "BLOCK"))).toEqual([
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "BLOCK" },
          { type: "image", source: {} },
        ],
      },
    },
  ]);
  expect(RIDE_ALONG_HEADER).toContain("not typed by the human");
});

it("a wake notice is not taken as a ride-along: it is the prompt of its own turn", async () => {
  active.add("busy-chat");
  enqueueChatNotice("busy-chat", "performed");
  enqueueChatNotice("busy-chat", "withdrawn", { wake: false });
  expect(claimRideAlongNotices("busy-chat")!.text).toContain("withdrawn");
  expect(peekChatNotices("busy-chat").map((n) => n.text)).toEqual(["performed"]);
});

it("held messages go first: a notice due at the same idle waits for the held turn to end", async () => {
  const held = ["the user's held message"];
  setIdleDeliveryHook(async (chatId) => {
    const next = held.shift();
    if (!next) return false;
    sent.push({ chatId, prompt: next });
    active.add(chatId);
    return true;
  });
  active.add("held-chat");
  enqueueChatNotice("held-chat", "Computer control update");
  await stop("held-chat");
  expect(sent.map((s) => s.prompt)).toEqual(["the user's held message"]);
  await stop("held-chat");
  expect(sent.map((s) => s.prompt)).toEqual(["the user's held message", "Computer control update"]);
});

it(`gives up on a notice after ${MAX_NOTICE_DELIVERY_ATTEMPTS} failed deliveries instead of retrying on every stop forever`, async () => {
  failingSends.add("stuck-chat");
  enqueueChatNotice("stuck-chat", "undeliverable");
  await settle();
  for (let i = 1; i < MAX_NOTICE_DELIVERY_ATTEMPTS; i++) {
    expect(peekChatNotices("stuck-chat")).toHaveLength(1);
    await stop("stuck-chat");
  }
  expect(peekChatNotices("stuck-chat")).toEqual([]);
  expect(sent).toEqual([]);
});
