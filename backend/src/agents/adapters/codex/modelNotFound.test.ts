import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import {
  CODEX_MODEL_NOT_FOUND_HEADLINE,
  type CodexModelNotFoundContext,
  codexModelNotFoundMessage,
  detectCodexModelNotFound,
  formatCodexModelNotFound,
} from "./modelNotFound.js";
import { translateCodexEvents } from "./messageAdapter.js";
import type { AgentEvent } from "../../ports/events.js";

/**
 * Verbatim from ~/.callboard/logs/callboard.log, 2026-11-27 07:08:04 (chat
 * 01a21ce7-c9f4-7813-8961-0949bcf8adde): the `message` of both the CLI's
 * `error` event and its `turn.failed` event.
 */
const REAL_PAYLOAD =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.5\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found","subreason":"model_not_in_accessible_catalog"}}';
const OPENAI_MESSAGE = "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";
/** The SDK's own throw once the CLI exits non-zero after the failure above. */
const EXEC_EXIT = "Codex Exec exited with code 1: Reading prompt from stdin...\n";

describe("detectCodexModelNotFound", () => {
  it("reads the real OpenAI payload", () => {
    expect(detectCodexModelNotFound(REAL_PAYLOAD)).toEqual({
      model: "gpt-5.5",
      openaiMessage: OPENAI_MESSAGE,
      code: "model_not_found",
      subreason: "model_not_in_accessible_catalog",
    });
  });

  it("finds the payload embedded in surrounding text (CLI stderr)", () => {
    const found = detectCodexModelNotFound(`Codex Exec exited with code 1: Reading prompt from stdin...\nERROR: ${REAL_PAYLOAD}\n`);
    expect(found?.model).toBe("gpt-5.5");
    expect(found?.openaiMessage).toBe(OPENAI_MESSAGE);
  });

  it("finds the payload stringified inside another JSON value", () => {
    const wrapped = JSON.stringify({ message: REAL_PAYLOAD, code: "model_not_found" });
    expect(detectCodexModelNotFound(wrapped)?.openaiMessage).toBe(OPENAI_MESSAGE);
    expect(detectCodexModelNotFound(JSON.stringify({ detail: REAL_PAYLOAD }))?.code).toBe("model_not_found");
  });

  it("detects on the subreason alone, and on a bare code with no JSON", () => {
    expect(detectCodexModelNotFound('{"error":{"message":"nope","subreason":"model_not_in_accessible_catalog"}}')?.subreason).toBe(
      "model_not_in_accessible_catalog",
    );
    const bare = detectCodexModelNotFound("model_not_found: The model `o9` does not exist");
    expect(bare?.openaiMessage).toBe("model_not_found: The model `o9` does not exist");
    expect(bare?.model).toBe("o9");
  });

  it("ignores unrelated errors, empty input, and an already-formatted message", () => {
    expect(detectCodexModelNotFound("stream disconnected before completion")).toBeNull();
    expect(detectCodexModelNotFound('{"error":{"code":"rate_limit_exceeded"}}')).toBeNull();
    expect(detectCodexModelNotFound(undefined)).toBeNull();
    expect(detectCodexModelNotFound("")).toBeNull();
    const formatted = codexModelNotFoundMessage(REAL_PAYLOAD, { requestedModel: "gpt-5.5" })!;
    expect(detectCodexModelNotFound(formatted)).toBeNull();
  });
});

describe("formatCodexModelNotFound", () => {
  const found = detectCodexModelNotFound(REAL_PAYLOAD)!;

  it("names the requested model, the client version and the fixes, and keeps OpenAI's message", () => {
    const msg = formatCodexModelNotFound(found, { requestedModel: "gpt-5.5", codexVersion: "0.153.4" });
    expect(msg.startsWith(CODEX_MODEL_NOT_FOUND_HEADLINE)).toBe(true);
    expect(msg).toContain("`gpt-5.5` is not in the model catalog this Codex client (codex-cli 0.153.4, bundled with Callboard) can access");
    expect(msg).toContain("list_codex_models");
    expect(msg).toContain("model picker");
    expect(msg).toContain("Update Callboard");
    expect(msg).toContain("Codex Binary");
    expect(msg).toContain(`OpenAI said: ${OPENAI_MESSAGE} (model_not_found / model_not_in_accessible_catalog)`);
    expect(msg).not.toContain("config.toml");
  });

  it("says the model came from config.toml when the chat set none", () => {
    const msg = formatCodexModelNotFound(found, { codexVersion: "0.153.4" });
    expect(msg).toContain("no model set — Codex used the `model` from ~/.codex/config.toml (`gpt-5.5`)");
    expect(msg).toContain("change `model` in ~/.codex/config.toml");
  });

  it("names the override binary instead of the bundled version", () => {
    const msg = formatCodexModelNotFound(found, { requestedModel: "gpt-5.5", codexVersion: "0.153.4", binaryOverride: "/opt/codex" });
    expect(msg).toContain("(override binary /opt/codex)");
    expect(msg).not.toContain("0.153.4");
  });
});

async function drive(source: () => AsyncGenerator<ThreadEvent>, ctx: CodexModelNotFoundContext = { requestedModel: "gpt-5.5", codexVersion: "0.153.4" }) {
  const out: AgentEvent[] = [];
  let thrown: unknown;
  try {
    for await (const ev of translateCodexEvents(source(), ctx)) out.push(ev);
  } catch (err) {
    thrown = err;
  }
  return { out, thrown };
}

describe("translateCodexEvents — model_not_found run", () => {
  /** The real failing run's shape: thread.started, item error, turn.started, error, turn.failed, then the exec exit throw. */
  async function* realRun(): AsyncGenerator<ThreadEvent> {
    yield { type: "thread.started", thread_id: "01a21ce7-c9f4-7813-8961-0949bcf8adde" };
    yield {
      type: "item.completed",
      item: {
        id: "item_0",
        type: "error",
        message: "Model metadata for `gpt-5.5` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
      },
    };
    yield { type: "turn.started" };
    yield { type: "error", message: REAL_PAYLOAD };
    yield { type: "turn.failed", error: { message: REAL_PAYLOAD } };
    throw new Error(EXEC_EXIT);
  }

  it("yields exactly one actionable result error and swallows the exec-exit throw that follows it", async () => {
    const { out, thrown } = await drive(realRun);
    expect(thrown).toBeUndefined();
    const results = out.filter((e) => e.type === "result");
    expect(results).toHaveLength(1);
    const result = results[0] as Extract<AgentEvent, { type: "result" }>;
    expect(result.status).toBe("error");
    expect(result.reason).toBe(codexModelNotFoundMessage(REAL_PAYLOAD, { requestedModel: "gpt-5.5", codexVersion: "0.153.4" }));
    expect(result.reason).not.toContain("Reading prompt from stdin");
  });

  it("formats a model_not_found that only arrives in the exec-exit stderr", async () => {
    async function* stderrOnly(): AsyncGenerator<ThreadEvent> {
      yield { type: "thread.started", thread_id: "t" };
      throw new Error(`${EXEC_EXIT}${REAL_PAYLOAD}`);
    }
    const { out, thrown } = await drive(stderrOnly, { codexVersion: "0.153.4" });
    expect(thrown).toBeUndefined();
    const result = out.at(-1) as Extract<AgentEvent, { type: "result" }>;
    expect(result).toMatchObject({ type: "result", status: "error" });
    expect(result.reason).toContain("no model set");
  });

  it("still re-throws an abort after a fatal error", async () => {
    async function* abortedAfterFatal(): AsyncGenerator<ThreadEvent> {
      yield { type: "error", message: REAL_PAYLOAD };
      const abort = new Error("The operation was aborted");
      abort.name = "AbortError";
      throw abort;
    }
    const { thrown } = await drive(abortedAfterFatal);
    expect((thrown as Error)?.name).toBe("AbortError");
  });

  it("still re-throws an exec failure when no fatal error was reported first", async () => {
    async function* crash(): AsyncGenerator<ThreadEvent> {
      yield { type: "thread.started", thread_id: "t" };
      throw new Error(EXEC_EXIT);
    }
    const { thrown } = await drive(crash);
    expect((thrown as Error)?.message).toBe(EXEC_EXIT);
  });

  it("keeps a turn.failed whose message differs from the preceding error", async () => {
    async function* twoErrors(): AsyncGenerator<ThreadEvent> {
      yield { type: "error", message: "reconnecting 1/5" };
      yield { type: "turn.failed", error: { message: "stream disconnected" } };
    }
    const { out } = await drive(twoErrors);
    expect(out.filter((e) => e.type === "result").map((e) => (e as { reason?: string }).reason)).toEqual(["reconnecting 1/5", "stream disconnected"]);
  });
});
