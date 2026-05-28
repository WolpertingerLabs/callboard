/**
 * Unit tests for slash-command wiring — exercises the real OR command loader
 * against an on-disk plugin fixture for listing, and the prompt-resolution
 * transform for both string and AsyncIterable prompts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins, type LoadedPlugin } from "@cybourgeoisie/openrouter-agent-coder";
import { buildCommandLoader, resolveCommandPrompt } from "./commandAdapter.js";

let tmpRoot: string;
let cwd: string;
let loaded: LoadedPlugin[];

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "or-cmd-"));
  cwd = join(tmpRoot, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });

  // A plugin contributing one command: commands/hello.md.
  const pluginDir = join(tmpRoot, "myplugin");
  const commandsDir = join(pluginDir, "commands");
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(join(commandsDir, "hello.md"), "Greetings, $ARGUMENTS — from the hello command.\n");

  loaded = await loadPlugins({ pluginDirs: [pluginDir] });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("buildCommandLoader — listing", () => {
  it("lists the plugin command under its namespaced name", async () => {
    const loader = buildCommandLoader(cwd, loaded);
    const names = (await loader.list()).map((c) => c.name);
    expect(names).toContain("myplugin:hello");
  });
});

describe("resolveCommandPrompt — string prompt", () => {
  it("resolves a leading-/ command to its rendered body", async () => {
    const loader = buildCommandLoader(cwd, loaded);
    const out = await resolveCommandPrompt("/myplugin:hello Ada", loader, "s1", cwd);
    expect(typeof out).toBe("string");
    expect((out as string).trim()).toBe("Greetings, Ada — from the hello command.");
  });

  it("passes through input that is not a slash command", async () => {
    const loader = buildCommandLoader(cwd, loaded);
    const out = await resolveCommandPrompt("just a normal message", loader, "s1", cwd);
    expect(out).toBe("just a normal message");
  });

  it("passes through a leading-/ string that names no known command", async () => {
    const loader = buildCommandLoader(cwd, loaded);
    const out = await resolveCommandPrompt("/path/to/some/file", loader, "s1", cwd);
    expect(out).toBe("/path/to/some/file");
  });
});

describe("resolveCommandPrompt — AsyncIterable prompt", () => {
  it("resolves string content per user message and forwards non-string content verbatim", async () => {
    const loader = buildCommandLoader(cwd, loaded);
    async function* prompt() {
      yield { content: "/myplugin:hello Bob" };
      yield { content: "plain follow-up" };
      yield { content: [{ type: "input_image", image_url: "data:..." }] };
    }
    const out = (await resolveCommandPrompt(prompt(), loader, "s1", cwd)) as AsyncIterable<{
      content: unknown;
    }>;
    const items: Array<{ content: unknown }> = [];
    for await (const item of out) items.push(item as { content: unknown });
    // First message resolved to the command body (trailing newline trimmed for
    // a stable assertion); the rest pass through verbatim.
    expect((items[0].content as string).trim()).toBe("Greetings, Bob — from the hello command.");
    expect(items[1]).toEqual({ content: "plain follow-up" });
    expect(items[2]).toEqual({ content: [{ type: "input_image", image_url: "data:..." }] });
  });
});
