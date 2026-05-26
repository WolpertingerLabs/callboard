/**
 * Unit tests for the Claude-shaped → OpenRouter options translation.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS } from "openrouter-agent-coder";
import { translateOptions, type OpenRouterOptionsExtras } from "./optionsAdapter.js";

const defaultExtras: OpenRouterOptionsExtras = { apiKey: "sk-or-test" };

describe("translateOptions — required config", () => {
  it("throws when openRouter.apiKey is missing", () => {
    expect(() => translateOptions({}, "hi")).toThrow(/apiKey/);
    expect(() => translateOptions({ openRouter: { apiKey: "" } as unknown as OpenRouterOptionsExtras }, "hi")).toThrow();
  });

  it("returns required fields with sensible defaults", () => {
    const { orOpts, cwd } = translateOptions({ openRouter: defaultExtras }, "do thing");
    expect(orOpts.apiKey).toBe("sk-or-test");
    expect(orOpts.prompt).toBe("do thing");
    expect(orOpts.sessionId).toMatch(/^[0-9a-f-]{36}$/); // UUID v4
    expect(orOpts.appTitle).toBe("callboard");
    expect(orOpts.settingSources).toEqual(["user", "project", "local"]);
    expect(cwd).toBe(process.cwd());
  });
});

describe("translateOptions — sessionId resolution", () => {
  it("uses options.resume when provided (session resume)", () => {
    const { orOpts } = translateOptions({ openRouter: defaultExtras, resume: "fixed-session-id" }, "hi");
    expect(orOpts.sessionId).toBe("fixed-session-id");
  });

  it("generates a fresh UUID when resume is absent", () => {
    const a = translateOptions({ openRouter: defaultExtras }, "hi").orOpts.sessionId;
    const b = translateOptions({ openRouter: defaultExtras }, "hi").orOpts.sessionId;
    expect(a).not.toBe(b);
  });
});

describe("translateOptions — systemPrompt resolution", () => {
  it("passes a plain string through verbatim", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, systemPrompt: "You are X." },
      "hi",
    );
    expect(orOpts.instructions).toBe("You are X.");
  });

  it("composes DEFAULT_INSTRUCTIONS + append for { preset, append }", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, systemPrompt: { type: "preset", preset: "claude_code", append: "extra" } },
      "hi",
    );
    expect(orOpts.instructions).toBe(`${DEFAULT_INSTRUCTIONS}\n\nextra`);
  });

  it("omits instructions entirely when preset has no append", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, systemPrompt: { type: "preset", preset: "claude_code" } },
      "hi",
    );
    expect(orOpts.instructions).toBeUndefined();
  });
});

describe("translateOptions — OR config passthrough", () => {
  it("threads baseUrl, model, logsRoot, appTitle into OR opts", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: {
          apiKey: "sk-or-test",
          baseUrl: "https://example.com",
          model: "google/gemini-2.0-flash",
          logsRoot: "/tmp/or-logs",
          appTitle: "custom-app",
        },
      },
      "hi",
    );
    expect(orOpts.baseUrl).toBe("https://example.com");
    expect(orOpts.model).toBe("google/gemini-2.0-flash");
    expect(orOpts.logsRoot).toBe("/tmp/or-logs");
    expect(orOpts.appTitle).toBe("custom-app");
  });
});

describe("translateOptions — Claude option passthrough", () => {
  it("threads maxTurns, cwd, allowedTools/disallowedTools, canUseTool, onHook, signal", () => {
    const ac = new AbortController();
    const canUseTool = async () => ({ behavior: "allow" as const });
    const onHook = async () => undefined;

    const { orOpts, cwd } = translateOptions(
      {
        openRouter: defaultExtras,
        cwd: "/tmp/work",
        maxTurns: 7,
        allowedTools: ["read_file"],
        disallowedTools: ["run_command"],
        canUseTool,
        onHook,
        abortController: ac,
      },
      "hi",
    );
    expect(cwd).toBe("/tmp/work");
    expect(orOpts.cwd).toBe("/tmp/work");
    expect(orOpts.maxTurns).toBe(7);
    expect(orOpts.allowedTools).toEqual(["read_file"]);
    expect(orOpts.disallowedTools).toEqual(["run_command"]);
    expect(orOpts.canUseTool).toBe(canUseTool);
    expect(orOpts.onHook).toBe(onHook);
    expect(orOpts.signal).toBe(ac.signal);
  });

  it("forwards stderr-level warnings through OR's logger", () => {
    const captured: string[] = [];
    const stderr = (msg: string) => captured.push(msg);
    const { orOpts } = translateOptions({ openRouter: defaultExtras, stderr }, "hi");
    expect(orOpts.logger).toBeDefined();
    orOpts.logger!("debug", "low");
    orOpts.logger!("info", "info");
    orOpts.logger!("warn", "warn msg");
    orOpts.logger!("error", "error msg");
    expect(captured).toEqual(["warn msg", "error msg"]);
  });

  it("drops empty allowedTools/disallowedTools arrays", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, allowedTools: [], disallowedTools: [] },
      "hi",
    );
    expect(orOpts.allowedTools).toBeUndefined();
    expect(orOpts.disallowedTools).toBeUndefined();
  });
});

describe("translateOptions — prompt translation", () => {
  it("passes a string prompt through unchanged", () => {
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, "hello");
    expect(orOpts.prompt).toBe("hello");
  });

  it("translates AsyncIterable<{type:'user', message:{content}}> → OR UserInput stream", async () => {
    async function* claudePrompt() {
      yield { type: "user", message: { role: "user", content: "first" } };
      yield { type: "user", message: { role: "user", content: "second" } };
    }
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, claudePrompt());
    const items: unknown[] = [];
    for await (const item of orOpts.prompt as AsyncIterable<{ content: string }>) {
      items.push(item);
    }
    expect(items).toEqual([{ content: "first" }, { content: "second" }]);
  });

  it("skips non-user-message items in the prompt iterable", async () => {
    async function* mixed() {
      yield { type: "user", message: { role: "user", content: "ok" } };
      yield { type: "assistant", message: { role: "assistant", content: "hi" } };
      yield "garbage";
    }
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, mixed());
    const items: unknown[] = [];
    for await (const item of orOpts.prompt as AsyncIterable<{ content: string }>) {
      items.push(item);
    }
    expect(items).toEqual([{ content: "ok" }]);
  });
});
