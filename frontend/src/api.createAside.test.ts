import { afterEach, expect, it, vi } from "vitest";
import { AsidesUnsupportedError, createAside } from "./api";

afterEach(() => vi.unstubAllGlobals());

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:05:00.000Z";
const quotes = [
  { timestamp: T1, role: "assistant" as const, text: "later" },
  { timestamp: T0, role: "user" as const, text: "earlier" },
];
const answering = (record: Record<string, unknown>) => {
  const fetcher = vi.fn(async (_url: unknown, _init: RequestInit) => ({ ok: true, json: async () => record }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

it("forks at the latest quote with kind aside, passing the first turn's plugins", async () => {
  const fetcher = answering({ id: "a", metadata: JSON.stringify({ chatRole: "aside" }), started: true });
  const res = await createAside("c", { quotes, prompt: "why?", permissions: { fileWrite: "ask" }, activePlugins: ["p1"], provider: "codex", model: "m" });
  expect(res).toMatchObject({ id: "a", started: true });
  expect(String(fetcher.mock.calls[0][0])).toMatch(/\/chats\/c\/fork$/);
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({
    timestamp: T1,
    kind: "aside",
    quotes,
    prompt: "why?",
    permissions: { fileWrite: "ask" },
    provider: "codex",
    model: "m",
    activePlugins: ["p1"],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

it("sends no plugins without a question", async () => {
  const fetcher = answering({ id: "a", metadata: JSON.stringify({ chatRole: "aside" }) });
  await createAside("c", { quotes, activePlugins: ["p1"] });
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).not.toHaveProperty("activePlugins");
});

it("throws AsidesUnsupportedError when an older daemon made a plain fork", async () => {
  answering({ id: "f", metadata: JSON.stringify({ chatRole: "fork" }) });
  const err = await createAside("c", { quotes, prompt: "why?" }).catch((e) => e);
  expect(err).toBeInstanceOf(AsidesUnsupportedError);
  expect(err.message).toMatch(/too old for asides/);
  expect(err.chat.id).toBe("f");
});

it("refuses without quotes, before any request", async () => {
  const fetcher = answering({});
  await expect(createAside("c", { quotes: [] })).rejects.toThrow(/at least one quote/);
  expect(fetcher).not.toHaveBeenCalled();
});

it("sends Read only as a flag for the daemon to apply", async () => {
  const fetcher = answering({ id: "a", metadata: JSON.stringify({ chatRole: "aside" }) });
  await createAside("c", { quotes, prompt: "why?", readOnly: true });
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toMatchObject({ readOnly: true });
  await createAside("c", { quotes, prompt: "why?" });
  expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).not.toHaveProperty("readOnly");
});
