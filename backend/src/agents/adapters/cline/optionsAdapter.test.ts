import { describe, it, expect } from "vitest";
import { buildClineStartConfig, DEFAULT_CLINE_PROVIDER_ID, resolveDefaultModelId, translateEffort } from "./optionsAdapter.js";

const base = { cwd: "/repo", sessionId: "sess1", extraTools: [] };

describe("translateEffort", () => {
  it("sends nothing when no effort is recorded", () => {
    // "don't send a reasoning payload", per shared/types/providers.ts
    expect(translateEffort(undefined)).toEqual({});
  });

  it('spells "none" as thinking off, not as an effort level', () => {
    // Cline's ReasoningEffort has no "none" member — the two vocabularies differ
    // by exactly this one value.
    expect(translateEffort("none")).toEqual({ thinking: false });
  });

  it("passes the shared levels straight through", () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh"] as const) {
      expect(translateEffort(level)).toEqual({ thinking: true, reasoningEffort: level });
    }
  });
});

/**
 * The regression that reached a user.
 *
 * The first cut passed `modelId: ""` when nothing resolved, on the assumption
 * Cline would fall back to its own default. It validates `modelId` with
 * `min(1)`, so the turn died before it started and the chat showed a raw Zod
 * dump instead of a reply.
 *
 * Reachable by an ordinary path: a chat on a model alias with no `cline` target
 * (`planner` had claude-code/openrouter/codex) plus a blank Settings → API
 * model. `resolveModelAlias` correctly returns undefined so the caller "falls
 * back to the provider's configured default" — and that default has to be a
 * real model id, which is what this now guarantees.
 */
describe("model fallback", () => {
  it("never yields an empty model id", () => {
    // The literal failure: modelId "" is rejected by the SDK's own schema.
    expect(buildClineStartConfig({ ...base, cline: {} }).modelId).not.toBe("");
    expect(buildClineStartConfig({ ...base, cline: { model: "   " } }).modelId).not.toBe("");
  });

  it("falls back to the SDK's own per-provider default, not a hardcoded id", () => {
    // Asked of the installed SDK rather than asserted as a literal, so an
    // upstream change to the default shows up as a real difference rather than
    // a test that has to be edited to match.
    for (const providerId of ["anthropic", "openai-native", "openrouter", "gemini"]) {
      const expected = resolveDefaultModelId(providerId);
      expect(expected.length).toBeGreaterThan(0);
      expect(buildClineStartConfig({ ...base, cline: { providerId } }).modelId).toBe(expected);
    }
  });

  it("still prefers an explicitly chosen model", () => {
    expect(buildClineStartConfig({ ...base, cline: { model: "claude-haiku-4-5" } }).modelId).toBe("claude-haiku-4-5");
  });

  it("raises something a human can act on when the provider is unknown", () => {
    // A Zod dump names no fix. This names two.
    expect(() => resolveDefaultModelId("not-a-real-provider")).toThrow(/Settings → API/);
  });
});

describe("buildClineStartConfig", () => {
  it("defaults the provider to anthropic", () => {
    expect(buildClineStartConfig({ ...base, cline: {} }).providerId).toBe(DEFAULT_CLINE_PROVIDER_ID);
  });

  /**
   * Three refusals, each deliberate. `yolo` is Cline's permission bypass;
   * teams add eighteen ungated coordination tools; subagent output arrives on
   * the one process-wide subscription with nowhere in callboard's event union
   * to render it.
   */
  it("refuses yolo, teams and subagents explicitly", () => {
    const config = buildClineStartConfig({ ...base, cline: {} });
    expect(config.yolo).toBe(false);
    expect(config.enableAgentTeams).toBe(false);
    expect(config.enableSpawnAgent).toBe(false);
    expect(config.enableTools).toBe(true);
  });

  /**
   * Checkpoints write git stashes and refs into the user's repository on every
   * run. Callboard already owns forking through its transcript and worktrees.
   */
  it("leaves checkpoints off, so nothing is written to the user's git state", () => {
    expect(buildClineStartConfig({ ...base, cline: {} }).checkpoint).toBeUndefined();
  });

  /**
   * Supplying the id is what lets the event-bus filter be correct from the
   * first event rather than from whenever `start()` resolves.
   */
  it("uses callboard's own session id", () => {
    expect(buildClineStartConfig({ ...base, cline: {} }).sessionId).toBe("sess1");
  });

  it("always sets cwd, so a pathless start cannot land in a shared workspace", () => {
    expect(buildClineStartConfig({ ...base, cline: {} }).cwd).toBe("/repo");
  });

  it("requests Cline's own workspace-aware system prompt", () => {
    // `systemPrompt` is required by CoreSessionConfig — there is no "let Cline
    // decide", so the default has to be asked for explicitly.
    expect(buildClineStartConfig({ ...base, cline: {} }).systemPrompt).toBeTruthy();
  });

  it("prefers an explicit system prompt when one is given", () => {
    expect(buildClineStartConfig({ ...base, cline: { systemPrompt: "Be terse." } }).systemPrompt).toBe("Be terse.");
  });

  it("omits credentials entirely when blank, so the SDK falls back to the environment", () => {
    const config = buildClineStartConfig({ ...base, cline: { apiKey: "  ", baseUrl: "" } });
    expect(config).not.toHaveProperty("apiKey");
    expect(config).not.toHaveProperty("baseUrl");
  });

  it("forwards credentials and the model when set", () => {
    const config = buildClineStartConfig({
      ...base,
      cline: { providerId: "openai-compatible", model: "anthropic/claude-opus-4.7", apiKey: "sk-x", baseUrl: "https://openrouter.ai/api/v1" },
    });
    expect(config).toMatchObject({
      providerId: "openai-compatible",
      modelId: "anthropic/claude-opus-4.7",
      apiKey: "sk-x",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("drops a non-positive iteration ceiling rather than passing it on", () => {
    expect(buildClineStartConfig({ ...base, cline: { maxIterations: 0 } })).not.toHaveProperty("maxIterations");
    expect(buildClineStartConfig({ ...base, cline: { maxIterations: 40 } }).maxIterations).toBe(40);
  });

  it("omits extraTools when callboard registered none", () => {
    expect(buildClineStartConfig({ ...base, cline: {} })).not.toHaveProperty("extraTools");
  });
});
