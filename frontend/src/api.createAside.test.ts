import { afterEach, expect, it, vi } from "vitest";
import { AsideRequestError, AsidesUnsupportedError, createAside } from "./api";

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

it("refuses without quotes and without a question, before any request", async () => {
  const fetcher = answering({});
  await expect(createAside("c", { quotes: [] })).rejects.toThrow(/needs a question/);
  await expect(createAside("c", {})).rejects.toThrow(/needs a question/);
  expect(fetcher).not.toHaveBeenCalled();
});

it("without quotes, asks the daemon to fork at the latest message and sends no timestamp", async () => {
  const fetcher = answering({ id: "a", metadata: JSON.stringify({ chatRole: "aside" }), started: true });
  await createAside("c", { prompt: "what now?", activePlugins: ["p1"] });
  await createAside("c", { quotes: [], prompt: "what now?" });
  for (const [, init] of fetcher.mock.calls) {
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ kind: "aside", forkAtLatest: true, prompt: "what now?" });
    expect(body).not.toHaveProperty("timestamp");
    expect(body).not.toHaveProperty("quotes");
  }
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string).activePlugins).toEqual(["p1"]);
});

it("sends attachments, with the first turn's plugins even without a question", async () => {
  const fetcher = answering({ id: "a", metadata: JSON.stringify({ chatRole: "aside" }), started: true, attachedImages: 2 });
  const res = await createAside("c", { quotes, imageIds: ["i1", "i2"], activePlugins: ["p1"] });
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toMatchObject({ timestamp: T1, quotes, imageIds: ["i1", "i2"], activePlugins: ["p1"] });
  expect(res.attachmentsDropped).toBeUndefined();
  await createAside("c", { quotes, prompt: "why?" });
  expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).not.toHaveProperty("imageIds");
});

it("flags attachments an older daemon dropped: no attachedImages in its answer", async () => {
  answering({ id: "a", metadata: JSON.stringify({ chatRole: "aside" }), started: true });
  expect(await createAside("c", { quotes, prompt: "why?", imageIds: ["i1"] })).toMatchObject({ id: "a", attachmentsDropped: true });
  expect(await createAside("c", { quotes, prompt: "why?" })).not.toHaveProperty("attachmentsDropped");
});

it("names an older daemon that wants a timestamp for an unquoted aside", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "timestamp is required" }) })),
  );
  const err = await createAside("c", { prompt: "why?" }).catch((e) => e);
  expect(err).toBeInstanceOf(AsideRequestError);
  expect(err.message).toMatch(/too old to ask an aside without quoting/);
  // With quotes the same words mean what they say.
  expect((await createAside("c", { quotes, prompt: "why?" }).catch((e) => e)).message).toBe("timestamp is required");
});

it("sends Read only as a flag for the daemon to apply", async () => {
  const fetcher = answering({ id: "a", metadata: JSON.stringify({ chatRole: "aside" }) });
  await createAside("c", { quotes, prompt: "why?", readOnly: true });
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toMatchObject({ readOnly: true });
  await createAside("c", { quotes, prompt: "why?" });
  expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).not.toHaveProperty("readOnly");
});

it("throws AsideRequestError with the status and code, marking a refused target", async () => {
  const refuse = (body: Record<string, unknown>) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, json: async () => body })),
    );
  refuse({ error: 'Unknown target provider "x"', code: "fork_target_invalid" });
  const target = await createAside("c", { quotes, prompt: "why?" }).catch((e) => e);
  expect(target).toBeInstanceOf(AsideRequestError);
  expect(target).toMatchObject({ message: 'Unknown target provider "x"', status: 400, code: "fork_target_invalid", targetRefused: true });

  refuse({ error: "quotes[0] is after the fork point" });
  const other = await createAside("c", { quotes, prompt: "why?" }).catch((e) => e);
  expect(other).toMatchObject({ status: 400, targetRefused: false });
});
