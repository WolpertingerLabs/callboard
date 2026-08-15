/**
 * OpenRouter Utility Completions — one non-streaming POST, no harness.
 *
 * Chat titles, git branch names and generated themes are one-shot calls: a
 * system prompt, a user prompt, one answer. They used to run through the
 * OpenRouter *agent harness*, which meant an agent loop, a tool registry and a
 * forced `return_result` MCP tool just to get a sentence back. The harness is
 * gone (see plans/remove-openrouter-engine.md); this module is what took its
 * place, and it is deliberately the smallest thing that can do the job —
 * `POST /chat/completions`, read `choices[0].message.content`.
 *
 * Plain `fetch` rather than `@openrouter/sdk`: openrouter-models.ts already
 * talks to this API this way, the surface needed here is a single request, and
 * the SDK was only ever in the lockfile transitively through the harness.
 *
 * The result shape mirrors {@link ./quick-completion.ts}'s
 * `QuickCompletionResult` exactly, so the helpers built on it (titles, branch
 * names, themes) do not care which backend ran.
 */
import { getAgentSettings } from "./agent-settings.js";
import { resolveOpenRouterApiUrl } from "./openrouter-endpoint.js";
import { createLogger } from "../utils/logger.js";
import type { AgentSettings } from "shared";

const log = createLogger("openrouter-completion");

/** Reasoning effort forwarded as OpenRouter's `reasoning.effort`. */
export type OpenRouterCompletionEffort = "low" | "medium" | "high";

export interface OpenRouterCompletionRequest {
  /** The user message. */
  prompt: string;
  /** System instructions. Omitted from the request when blank. */
  systemPrompt?: string;
  /** Full OpenRouter model slug or alias (e.g. `~anthropic/claude-haiku-latest`). */
  model: string;
  /** Reasoning effort. Default: "low". */
  effort?: OpenRouterCompletionEffort;
  /** Caller cancellation, composed with the internal timeout. */
  signal?: AbortSignal;
}

export interface OpenRouterCompletionResult {
  /** The assistant's answer text. */
  text: string;
  /** Token usage and cost, as reported by OpenRouter. */
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  /** Wall-clock duration in milliseconds, measured here (OR reports none). */
  durationMs: number;
}

/**
 * How long a single attempt may take. Sized for the long pole, which is theme
 * generation on the sonnet tier: it asks for ~90 CSS variables in two modes and
 * routinely runs past 30s. Titles and branch names finish in a second or two,
 * so this ceiling only ever bites on a genuinely stuck request.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Backoff before each retry. Two retries, three attempts total.
 *
 * This is a bug fix, not a nicety. The harness had its own retry, but it keyed
 * on a `statusCode` property that OpenRouter's HTTP-level 500s never carried —
 * so a 500 (which OR returns often enough under load) failed the whole call on
 * the first try and the user simply got no title. Retrying on the transport's
 * own terms is the fix.
 */
const RETRY_DELAYS_MS = [500, 1500];

/** Attempts a completion gets in total: the first plus one per backoff delay. */
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** QuickModel tier → the settings field holding its OpenRouter slug. */
const TIER_SETTING: Record<"haiku" | "sonnet" | "opus", keyof AgentSettings> = {
  haiku: "openRouterUtilityHaikuModel",
  sonnet: "openRouterUtilitySonnetModel",
  opus: "openRouterUtilityOpusModel",
};

/**
 * Whether utility completions should run on OpenRouter: the user opted in AND a
 * key exists. Both halves matter — the toggle without a key is a request we
 * cannot serve, and a key without the toggle belongs to some other feature
 * (the ACP fallback, a routed native harness) and must not be spent here.
 */
export function isOpenRouterUtilityCompletionEnabled(settings?: AgentSettings): boolean {
  const s = settings ?? getAgentSettings();
  return Boolean(s.openRouterUtilityCompletions) && Boolean(s.openRouterApiKey?.trim());
}

/**
 * Resolve the OpenRouter model for a utility tier: the user's configured slug,
 * else OpenRouter's own dynamic alias for that tier. The `~` aliases resolve
 * server-side to the current model of each tier, so the cheap tier stays cheap
 * without a version number maintained in this repo.
 */
export function resolveUtilityModel(tier: "haiku" | "sonnet" | "opus", settings?: AgentSettings): string {
  const s = settings ?? getAgentSettings();
  const configured = s[TIER_SETTING[tier]];
  const slug = typeof configured === "string" ? configured.trim() : "";
  return slug || `~anthropic/claude-${tier}-latest`;
}

/** Raw shape of the fields we read from OpenRouter's chat-completions response. */
interface RawCompletionResponse {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

/** Promise that resolves after `ms`. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a failed attempt is worth repeating. Rate limits and server-side
 * faults are transient by definition, and a connection that never opened
 * (DNS, socket, TLS) never got an answer at all; a 400/401/404 is a request
 * this key will never be allowed to make, so retrying it just delays the error
 * the caller needs to see.
 *
 * Two aborts are excluded, under the names the platform gives them:
 *  - `AbortError` — the caller cancelled. Repeating a cancelled call is the
 *    exact opposite of what was asked for.
 *  - `TimeoutError` — the attempt used its whole {@link REQUEST_TIMEOUT_MS}
 *    budget. An endpoint that has held the connection open for a full minute
 *    without answering is not having a transient blip, and the cost of guessing
 *    otherwise lands on a user: `POST /api/themes/generate` awaits
 *    generateThemeCSS synchronously, and that makes up to
 *    THEME_GENERATION_ATTEMPTS calls of its own. Retrying timeouts would turn a
 *    dead endpoint into ~6 minutes with the HTTP request held open.
 */
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  const name = (err as { name?: string })?.name;
  return name !== "AbortError" && name !== "TimeoutError";
}

/** An HTTP error carrying the status so {@link isRetryable} can read it. */
class OpenRouterHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OpenRouterHttpError";
  }
}

/**
 * An attempt that was aborted, re-thrown under a name {@link isRetryable}
 * recognizes and a message that says WHO aborted it.
 *
 * `fetch` rejects with the composed signal's reason, which is a bare
 * DOMException — true but useless in a log, since "this operation was aborted"
 * reads identically whether the user closed the tab or OpenRouter went silent
 * for a minute. Both are terminal, so the distinction changes no control flow;
 * it changes whether the line in the log tells you what happened.
 */
class OpenRouterAbortError extends Error {
  constructor(message: string, kind: "caller" | "timeout") {
    super(message);
    this.name = kind === "timeout" ? "TimeoutError" : "AbortError";
  }
}

/**
 * Run one utility completion against OpenRouter.
 *
 * No `tools` are sent: no caller passes any, and the whole point of leaving the
 * harness behind is that a one-shot answer needs no tool-call apparatus to
 * capture it. The answer is simply the assistant message.
 *
 * Throws when no API key is configured, when every attempt fails, or when the
 * response carries no usable text.
 */
export async function runOpenRouterCompletion(req: OpenRouterCompletionRequest): Promise<OpenRouterCompletionResult> {
  const settings = getAgentSettings();
  const apiKey = settings.openRouterApiKey?.trim();
  if (!apiKey) {
    throw new Error("OpenRouter is selected for utility completions but no API key is configured in Settings → API.");
  }

  const url = resolveOpenRouterApiUrl("/chat/completions", settings);
  const effort = req.effort ?? "low";
  const body = JSON.stringify({
    model: req.model,
    messages: [...(req.systemPrompt?.trim() ? [{ role: "system", content: req.systemPrompt }] : []), { role: "user", content: req.prompt }],
    reasoning: { effort },
    // Ask OpenRouter to attach real token counts and the actual charged cost,
    // rather than leaving the caller to estimate from a price table.
    usage: { include: true },
  });

  const started = Date.now();
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptCompletion({ url, apiKey, body, signal: req.signal, startedAt: started });
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) throw err;
      // Logged here rather than at the top of the next iteration so the number
      // names the attempt that actually failed, counting the way a human does.
      const wait = RETRY_DELAYS_MS[attempt - 1];
      log.warn(`OpenRouter completion attempt ${attempt} of ${MAX_ATTEMPTS} failed (${(err as Error)?.message}) — retrying in ${wait}ms`);
      await delay(wait);
    }
  }

  // Unreachable — the loop either returns or throws — but the compiler wants a
  // terminal statement and a thrown lastErr is the honest one.
  throw lastErr;
}

/** One HTTP attempt, with its own timeout composed onto the caller's signal. */
async function attemptCompletion(opts: { url: string; apiKey: string; body: string; signal?: AbortSignal; startedAt: number }): Promise<OpenRouterCompletionResult> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  try {
    return await sendCompletion({ ...opts, signal });
  } catch (err) {
    // Attribute an abort to whichever signal fired. Checked in this order
    // because a caller who cancels while the clock also happens to run out is
    // still a cancellation, and the composed reason cannot tell us apart.
    if (opts.signal?.aborted) throw new OpenRouterAbortError("OpenRouter completion cancelled by the caller", "caller");
    if (timeout.aborted) throw new OpenRouterAbortError(`OpenRouter completion timed out after ${REQUEST_TIMEOUT_MS}ms`, "timeout");
    throw err;
  }
}

/** The request itself, once the effective signal is settled. */
async function sendCompletion(opts: { url: string; apiKey: string; body: string; signal: AbortSignal; startedAt: number }): Promise<OpenRouterCompletionResult> {
  const res = await fetch(opts.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      // Identifies callboard on OpenRouter's activity page — the same title the
      // harness used to send as `appTitle`.
      "X-Title": "callboard",
    },
    body: opts.body,
    signal: opts.signal,
  });

  if (!res.ok) {
    // The body usually carries OR's own explanation; a failure to read it must
    // not mask the status, which is the part that decides whether we retry.
    const detail = await res.text().catch(() => "");
    throw new OpenRouterHttpError(`OpenRouter HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}`, res.status);
  }

  const json = (await res.json()) as RawCompletionResponse;
  // A 200 with an `error` object happens on provider-side failures routed
  // through OR. Surface it as an error rather than as an empty title.
  if (json.error?.message) throw new Error(`OpenRouter returned an error: ${json.error.message}`);

  const content = json.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) throw new Error("OpenRouter returned no completion text");

  const durationMs = Date.now() - opts.startedAt;
  const usage = {
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    costUsd: json.usage?.cost ?? 0,
  };
  log.debug(`OpenRouter completion — ${durationMs}ms, tokens=${usage.inputTokens}+${usage.outputTokens}, cost=$${usage.costUsd.toFixed(4)}`);

  return { text, usage, durationMs };
}
