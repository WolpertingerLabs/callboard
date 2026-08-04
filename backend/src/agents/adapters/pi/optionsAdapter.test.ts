import { describe, it, expect } from "vitest";
import { buildPiSessionOptions, translateThinkingLevel, resolvePiAgentDir, DEFAULT_PI_PROVIDER_ID } from "./optionsAdapter.js";
import type { EffortLevel } from "shared/types/index.js";

describe("translateThinkingLevel", () => {
  it.each(["xhigh", "high", "medium", "low", "minimal"] as const)("passes %s through verbatim", (effort) => {
    expect(translateThinkingLevel(effort)).toEqual({ thinkingLevel: effort });
  });

  it("maps callboard's 'none' onto pi's 'off'", () => {
    expect(translateThinkingLevel("none")).toEqual({ thinkingLevel: "off" });
  });

  /**
   * Not a stylistic choice. The spike hit a hard 400 from
   * `google/gemini-3.6-flash`: "Reasoning is mandatory for this endpoint and
   * cannot be disabled." Defaulting an effort-less chat to "off" would break
   * that whole class of models for every user who never touched the control.
   */
  it("sends nothing at all when no effort is recorded, rather than defaulting to off", () => {
    expect(translateThinkingLevel(undefined)).toEqual({});
    expect(translateThinkingLevel(undefined)).not.toHaveProperty("thinkingLevel");
  });

  it("covers every EffortLevel the shared type declares", () => {
    const all: EffortLevel[] = ["xhigh", "high", "medium", "low", "minimal", "none"];
    for (const effort of all) {
      expect(translateThinkingLevel(effort).thinkingLevel).toBeTruthy();
    }
  });
});

describe("resolvePiAgentDir", () => {
  it("is callboard's own directory, never the user's ~/.pi/agent", () => {
    const dir = resolvePiAgentDir();
    expect(dir).toContain("pi-agent");
    expect(dir).not.toMatch(/[/\\]\.pi[/\\]agent$/);
  });

  it("is a function so a per-test CALLBOARD_DATA_DIR is honoured", () => {
    expect(typeof resolvePiAgentDir).toBe("function");
  });
});

describe("buildPiSessionOptions", () => {
  const base = { pi: {}, customTools: [], filters: {} };

  it("omits every optional key when nothing is configured", () => {
    const options = buildPiSessionOptions(base);
    expect(options).toEqual({});
  });

  it("passes the resolved model through", () => {
    const model = { id: "google/gemini-3.6-flash", provider: "openrouter" } as never;
    expect(buildPiSessionOptions({ ...base, model }).model).toBe(model);
  });

  it("carries the thinking level from the effort axis", () => {
    expect(buildPiSessionOptions({ ...base, pi: { effort: "high" } }).thinkingLevel).toBe("high");
  });

  it("includes customTools only when there are some", () => {
    expect(buildPiSessionOptions(base)).not.toHaveProperty("customTools");
    const tools = [{ name: "t" }] as never[];
    expect(buildPiSessionOptions({ ...base, customTools: tools }).customTools).toBe(tools);
  });

  it("passes the tool filters straight through", () => {
    const options = buildPiSessionOptions({ ...base, filters: { tools: ["read", "set_chat_title"], excludeTools: ["bash"] } });
    expect(options.tools).toEqual(["read", "set_chat_title"]);
    expect(options.excludeTools).toEqual(["bash"]);
  });

  it("omits filters entirely when no axis narrows anything", () => {
    const options = buildPiSessionOptions(base);
    expect(options).not.toHaveProperty("tools");
    expect(options).not.toHaveProperty("excludeTools");
  });

  it("never sets a tool allowlist without being asked to", () => {
    // An accidental empty allowlist would leave the model with no tools at all.
    expect(buildPiSessionOptions({ ...base, pi: { effort: "low" } }).tools).toBeUndefined();
  });
});

describe("DEFAULT_PI_PROVIDER_ID", () => {
  it("is openrouter — the provider pi is native to", () => {
    expect(DEFAULT_PI_PROVIDER_ID).toBe("openrouter");
  });
});
