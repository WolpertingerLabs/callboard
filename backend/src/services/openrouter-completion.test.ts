/**
 * The OpenRouter utility completion client, driven against a mocked `fetch`.
 *
 * What matters here is everything the old harness used to do for us and now
 * doesn't: hitting the endpoint the key actually belongs to, surviving a 5xx,
 * mapping OR's usage fields onto the shape the callers read, and failing
 * legibly when there is no key. No network is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSettings } from "shared";

vi.mock("./agent-settings.js", () => ({
  getAgentSettings: vi.fn((): AgentSettings => ({ proxyMode: "local" })),
}));

import { isOpenRouterUtilityCompletionEnabled, resolveUtilityModel, runOpenRouterCompletion } from "./openrouter-completion.js";
import { OPENROUTER_DEFAULT_BASE_URL, resolveOpenRouterApiUrl } from "./openrouter-endpoint.js";
import { getAgentSettings } from "./agent-settings.js";

const mockGetAgentSettings = vi.mocked(getAgentSettings);

/** Settings with the utility path fully configured. */
const configured = (extra?: Partial<AgentSettings>): AgentSettings => ({
  proxyMode: "local",
  openRouterApiKey: "sk-or-test",
  openRouterUtilityCompletions: true,
  ...extra,
});

/** A well-formed chat-completions response body. */
function okBody(text: string, usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ choices: [{ message: { content: text } }], ...(usage ? { usage } : {}) }),
    text: async () => "",
  } as unknown as Response;
}

/** An HTTP failure response with the given status. */
function errorBody(status: number, detail = "boom") {
  return {
    ok: false,
    status,
    statusText: "Error",
    json: async () => ({}),
    text: async () => detail,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGetAgentSettings.mockReturnValue(configured());
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** The request body this module builds, as sent over the wire. */
interface SentBody {
  model: string;
  messages: { role: string; content: string }[];
  reasoning?: { effort: string };
  usage?: { include: boolean };
  tools?: unknown;
}

/** The parsed JSON body of the nth recorded fetch call. */
function sentBody(call = 0): SentBody {
  return JSON.parse(fetchMock.mock.calls[call][1].body) as SentBody;
}

describe("resolveOpenRouterApiUrl — shared with the model catalog", () => {
  it("defaults to OpenRouter's v1 API", () => {
    expect(resolveOpenRouterApiUrl("/chat/completions")).toBe(`${OPENROUTER_DEFAULT_BASE_URL}/chat/completions`);
    // The catalog resolves through the same helper, which is the point: a key
    // configured for a mirror must not fetch its model list from another host.
    expect(resolveOpenRouterApiUrl("/models")).toBe(`${OPENROUTER_DEFAULT_BASE_URL}/models`);
  });

  it("honors a configured base URL, trimming whitespace and trailing slashes", () => {
    mockGetAgentSettings.mockReturnValue(configured({ openRouterBaseUrl: "  https://eu.openrouter.ai/api/v1///  " }));
    expect(resolveOpenRouterApiUrl("/chat/completions")).toBe("https://eu.openrouter.ai/api/v1/chat/completions");
  });

  it("falls back to the default when the configured value is blank", () => {
    mockGetAgentSettings.mockReturnValue(configured({ openRouterBaseUrl: "   " }));
    expect(resolveOpenRouterApiUrl("/models")).toBe(`${OPENROUTER_DEFAULT_BASE_URL}/models`);
  });
});

describe("isOpenRouterUtilityCompletionEnabled", () => {
  it("requires both the opt-in and a key", () => {
    expect(isOpenRouterUtilityCompletionEnabled(configured())).toBe(true);
    // A key on its own belongs to some other feature (the ACP fallback, a routed
    // native harness) and must not be spent on titles.
    expect(isOpenRouterUtilityCompletionEnabled({ proxyMode: "local", openRouterApiKey: "sk-or-test" })).toBe(false);
    // The toggle on its own is a request we cannot serve.
    expect(isOpenRouterUtilityCompletionEnabled({ proxyMode: "local", openRouterUtilityCompletions: true })).toBe(false);
    expect(isOpenRouterUtilityCompletionEnabled({ proxyMode: "local", openRouterUtilityCompletions: true, openRouterApiKey: "  " })).toBe(false);
  });
});

describe("resolveUtilityModel", () => {
  it("falls back to OpenRouter's dynamic tier aliases", () => {
    expect(resolveUtilityModel("haiku", configured())).toBe("~anthropic/claude-haiku-latest");
    expect(resolveUtilityModel("sonnet", configured())).toBe("~anthropic/claude-sonnet-latest");
    expect(resolveUtilityModel("opus", configured())).toBe("~anthropic/claude-opus-latest");
  });

  it("uses the configured slug for a tier, ignoring blanks", () => {
    const s = configured({ openRouterUtilityHaikuModel: "  google/gemini-2.0-flash  ", openRouterUtilitySonnetModel: "   " });
    expect(resolveUtilityModel("haiku", s)).toBe("google/gemini-2.0-flash");
    expect(resolveUtilityModel("sonnet", s)).toBe("~anthropic/claude-sonnet-latest");
  });
});

describe("runOpenRouterCompletion — the request", () => {
  it("posts one system + user message to the resolved endpoint with the key and app title", async () => {
    fetchMock.mockResolvedValue(okBody("A Great Title"));

    const result = await runOpenRouterCompletion({ prompt: "name this chat", systemPrompt: "be brief", model: "~anthropic/claude-haiku-latest" });

    expect(result.text).toBe("A Great Title");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${OPENROUTER_DEFAULT_BASE_URL}/chat/completions`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-or-test");
    expect(init.headers["X-Title"]).toBe("callboard");
    expect(sentBody()).toMatchObject({
      model: "~anthropic/claude-haiku-latest",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "name this chat" },
      ],
      reasoning: { effort: "low" },
      usage: { include: true },
    });
  });

  it("sends no tools — a one-shot answer needs no capture apparatus", async () => {
    fetchMock.mockResolvedValue(okBody("x"));
    await runOpenRouterCompletion({ prompt: "x", model: "m" });
    expect(sentBody().tools).toBeUndefined();
  });

  it("omits the system message when there is none, and forwards the effort", async () => {
    fetchMock.mockResolvedValue(okBody("x"));
    await runOpenRouterCompletion({ prompt: "x", systemPrompt: "  ", model: "m", effort: "medium" });
    expect(sentBody().messages).toEqual([{ role: "user", content: "x" }]);
    expect(sentBody().reasoning).toEqual({ effort: "medium" });
  });

  it("throws before any request when no API key is configured", async () => {
    mockGetAgentSettings.mockReturnValue({ proxyMode: "local", openRouterUtilityCompletions: true });
    await expect(runOpenRouterCompletion({ prompt: "x", model: "m" })).rejects.toThrow(/no API key is configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("runOpenRouterCompletion — the response", () => {
  it("maps OpenRouter's usage fields onto the QuickCompletionResult shape", async () => {
    fetchMock.mockResolvedValue(okBody("answer", { prompt_tokens: 123, completion_tokens: 45, cost: 0.00678 }));
    const result = await runOpenRouterCompletion({ prompt: "x", model: "m" });
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 45, costUsd: 0.00678 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("defaults usage to zeros when the response reports none", async () => {
    fetchMock.mockResolvedValue(okBody("answer"));
    const result = await runOpenRouterCompletion({ prompt: "x", model: "m" });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it("trims the answer", async () => {
    fetchMock.mockResolvedValue(okBody("  Padded Title \n"));
    await expect(runOpenRouterCompletion({ prompt: "x", model: "m" })).resolves.toMatchObject({ text: "Padded Title" });
  });

  it("rejects an empty completion rather than returning a blank title", async () => {
    fetchMock.mockResolvedValue(okBody("   "));
    await expect(runOpenRouterCompletion({ prompt: "x", model: "m" })).rejects.toThrow(/no completion text/i);
  });

  it("surfaces a provider error delivered inside a 200 body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ error: { message: "upstream refused" } }),
      text: async () => "",
    } as unknown as Response);
    await expect(runOpenRouterCompletion({ prompt: "x", model: "m" })).rejects.toThrow(/upstream refused/);
  });
});

/**
 * The retry is the bug fix this module carries: OpenRouter's HTTP-level 500s
 * never reached the harness's retry, which keyed on a `statusCode` property they
 * did not have, so one bad response meant no title at all.
 */
describe("runOpenRouterCompletion — retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /**
   * Drive the backoff timers while a completion is in flight, then re-raise
   * whatever it settled with. The outcome is captured before the timers advance
   * so a rejection cannot escape as an unhandled one.
   */
  async function settle<T>(pending: Promise<T>): Promise<T> {
    const outcome = pending.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    const settled = await outcome;
    if (!settled.ok) throw settled.error;
    return settled.value;
  }

  it("retries a 500 and succeeds on the second attempt", async () => {
    fetchMock.mockResolvedValueOnce(errorBody(500)).mockResolvedValueOnce(okBody("Recovered"));
    const result = await settle(runOpenRouterCompletion({ prompt: "x", model: "m" }));
    expect(result.text).toBe("Recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 and a network failure", async () => {
    fetchMock.mockResolvedValueOnce(errorBody(429)).mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(okBody("Recovered"));
    const result = await settle(runOpenRouterCompletion({ prompt: "x", model: "m" }));
    expect(result.text).toBe("Recovered");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after three attempts and reports the last failure", async () => {
    fetchMock.mockResolvedValue(errorBody(503, "overloaded"));
    await expect(settle(runOpenRouterCompletion({ prompt: "x", model: "m" }))).rejects.toThrow(/503.*overloaded/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a 401 — the key will never be allowed to make that request", async () => {
    fetchMock.mockResolvedValue(errorBody(401, "invalid key"));
    await expect(settle(runOpenRouterCompletion({ prompt: "x", model: "m" }))).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 400", async () => {
    fetchMock.mockResolvedValue(errorBody(400, "bad model"));
    await expect(settle(runOpenRouterCompletion({ prompt: "x", model: "m" }))).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry an abort — the caller asked for it to stop", async () => {
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchMock.mockRejectedValue(aborted);
    await expect(settle(runOpenRouterCompletion({ prompt: "x", model: "m" }))).rejects.toThrow(/aborted/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Aborts, of which there are two kinds that must not be conflated.
 *
 * These run on real timers and assert against the DOMException Node itself
 * raises, because the bug they guard was exactly a mismatch between what the
 * platform names an abort and what this module tested for: `AbortSignal.timeout`
 * rejects with `TimeoutError`, NOT `AbortError`, so a hand-rolled stand-in would
 * have agreed with the broken predicate.
 */
describe("runOpenRouterCompletion — timeouts and cancellation", () => {
  /** The genuine reason Node attaches when an `AbortSignal.timeout` fires. */
  async function realTimeoutReason(): Promise<Error> {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return signal.reason as Error;
  }

  it("names a fired timeout TimeoutError, not AbortError", async () => {
    // Pins the platform behavior the predicate depends on. If a future Node
    // changes this, the test below stops meaning what it says — better to fail
    // here, where the reason is written down.
    const reason = await realTimeoutReason();
    expect(reason.constructor.name).toBe("DOMException");
    expect(reason.name).toBe("TimeoutError");
  });

  it("does NOT retry an attempt that spent its whole timeout budget", async () => {
    // A minute of silence is not a transient blip, and the theme route awaits
    // this synchronously — retrying would hold an HTTP request open for minutes
    // against a dead endpoint.
    fetchMock.mockRejectedValue(await realTimeoutReason());
    await expect(runOpenRouterCompletion({ prompt: "x", model: "m" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a caller's cancellation, and says who cancelled", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          controller.abort();
        }),
    );

    await expect(runOpenRouterCompletion({ prompt: "x", model: "m", signal: controller.signal })).rejects.toThrow(/cancelled by the caller/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
