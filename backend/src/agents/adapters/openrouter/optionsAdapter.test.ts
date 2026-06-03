/**
 * Unit tests for the Claude-shaped → OpenRouter options translation.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS } from "@wolpertingerlabs/openrouter-agent-harness";
import { extractPluginDirs, translateOptions, type OpenRouterOptionsExtras } from "./optionsAdapter.js";

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

  it("forwards effort onto orOpts.effort when set", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: {
          apiKey: "sk-or-test",
          effort: "medium",
        },
      },
      "hi",
    );
    expect(orOpts.effort).toBe("medium");
  });

  it("omits effort entirely when unset (preserves model default behavior)", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: { apiKey: "sk-or-test" },
      },
      "hi",
    );
    expect(orOpts.effort).toBeUndefined();
  });

  it("always sets cacheControl to ephemeral (auto prompt caching for Anthropic; no-op elsewhere)", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: { apiKey: "sk-or-test" },
      },
      "hi",
    );
    expect(orOpts.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("always enables OpenRouter server tools (disableServerTools is false)", () => {
    const { orOpts } = translateOptions({ openRouter: { apiKey: "sk-or-test" } }, "hi");
    expect(orOpts.disableServerTools).toBe(false);
  });

  it("forwards maxBudgetUsd onto orOpts.maxBudgetUsd when set", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: {
          apiKey: "sk-or-test",
          maxBudgetUsd: 5.5,
        },
      },
      "hi",
    );
    expect(orOpts.maxBudgetUsd).toBe(5.5);
  });

  it("omits maxBudgetUsd when unset so the OR library falls back to its default", () => {
    const { orOpts } = translateOptions(
      {
        openRouter: { apiKey: "sk-or-test" },
      },
      "hi",
    );
    expect(orOpts.maxBudgetUsd).toBeUndefined();
  });

  it("rejects non-finite maxBudgetUsd values (NaN, Infinity) so a corrupt setting can't poison the run", () => {
    const { orOpts: withNaN } = translateOptions(
      {
        openRouter: { apiKey: "sk-or-test", maxBudgetUsd: Number.NaN },
      },
      "hi",
    );
    expect(withNaN.maxBudgetUsd).toBeUndefined();

    const { orOpts: withInf } = translateOptions(
      {
        openRouter: { apiKey: "sk-or-test", maxBudgetUsd: Number.POSITIVE_INFINITY },
      },
      "hi",
    );
    expect(withInf.maxBudgetUsd).toBeUndefined();
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

  it("forwards persistSession: false so ephemeral calls write no session record", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, persistSession: false },
      "hi",
    );
    expect(orOpts.persistSession).toBe(false);
  });

  it("forwards persistSession: true explicitly", () => {
    const { orOpts } = translateOptions(
      { openRouter: defaultExtras, persistSession: true },
      "hi",
    );
    expect(orOpts.persistSession).toBe(true);
  });

  it("leaves persistSession undefined when not specified (OR library default applies)", () => {
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, "hi");
    expect(orOpts.persistSession).toBeUndefined();
  });
});

describe("extractPluginDirs — plugin descriptor → loadPlugins dirs", () => {
  it("returns [] when no plugins are present", () => {
    expect(extractPluginDirs({})).toEqual([]);
    expect(extractPluginDirs({ plugins: undefined })).toEqual([]);
    expect(extractPluginDirs({ plugins: [] })).toEqual([]);
  });

  it("pulls .path from local plugin descriptors (the Claude-shaped form)", () => {
    const dirs = extractPluginDirs({
      plugins: [
        { type: "local", path: "/abs/plugin-a", name: "a" },
        { type: "local", path: "/abs/plugin-b", name: "b" },
      ],
    });
    expect(dirs).toEqual(["/abs/plugin-a", "/abs/plugin-b"]);
  });

  it("treats a missing type as local (path is enough)", () => {
    expect(extractPluginDirs({ plugins: [{ path: "/abs/p", name: "p" }] })).toEqual(["/abs/p"]);
  });

  it("skips descriptors with no usable path or a non-local source type", () => {
    const dirs = extractPluginDirs({
      plugins: [
        { type: "local", path: "/abs/keep", name: "keep" },
        { type: "local", name: "no-path" },
        { type: "remote", path: "/abs/remote", name: "remote" },
        { type: "local", path: "", name: "empty" },
      ],
    });
    expect(dirs).toEqual(["/abs/keep"]);
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

  it("collapses text-only ContentBlock[] into a single string", async () => {
    async function* prompt() {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        },
      };
    }
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, prompt());
    const items: unknown[] = [];
    for await (const item of orOpts.prompt as AsyncIterable<{
      content: string | readonly unknown[];
    }>) {
      items.push(item);
    }
    expect(items).toEqual([{ content: "line one\nline two" }]);
  });

  it("forwards base64 image blocks as OR input_image with data: URI", async () => {
    async function* prompt() {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      };
    }
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, prompt());
    const items: unknown[] = [];
    for await (const item of orOpts.prompt as AsyncIterable<{
      content: string | readonly unknown[];
    }>) {
      items.push(item);
    }
    expect(items).toEqual([
      {
        content: [
          { type: "input_text", text: "describe this" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    ]);
  });

  it("forwards url image blocks as OR input_image with the URL passed through", async () => {
    async function* prompt() {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "https://x/y.png" } },
          ],
        },
      };
    }
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, prompt());
    const items: unknown[] = [];
    for await (const item of orOpts.prompt as AsyncIterable<{
      content: string | readonly unknown[];
    }>) {
      items.push(item);
    }
    expect(items).toEqual([
      {
        content: [{ type: "input_image", image_url: "https://x/y.png" }],
      },
    ]);
  });

  it("falls back to a text placeholder for image blocks with an unrecognized source", async () => {
    async function* prompt() {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", source: { type: "weird", media_type: "image/heic" } },
          ],
        },
      };
    }
    const { orOpts } = translateOptions({ openRouter: defaultExtras }, prompt());
    const items: unknown[] = [];
    for await (const item of orOpts.prompt as AsyncIterable<{
      content: string | readonly unknown[];
    }>) {
      items.push(item);
    }
    // No image survived, so this collapses back to a plain string.
    expect(items).toEqual([{ content: "hi\n[image:image/heic]" }]);
  });
});
