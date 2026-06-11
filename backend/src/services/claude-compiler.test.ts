import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSystemPrompt, compileIdentityPrompt, compileWorkspaceContext } from "./claude-compiler.js";
import type { AgentConfig } from "shared";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Test Agent",
    alias: "test-agent",
    description: "An agent for testing",
    createdAt: 0,
    role: "tester",
    ...overrides,
  };
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

describe("compileSystemPrompt", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "claude-compiler-test-"));
    mkdirSync(join(workspace, "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("assembles the same prompt as the identity + workspace compilers joined", () => {
    writeFileSync(join(workspace, "SOUL.md"), "# Soul\nBe kind.");
    const config = makeConfig();

    const compiled = compileSystemPrompt(config, workspace);
    const expected = [compileIdentityPrompt(config), compileWorkspaceContext(workspace)].filter(Boolean).join("\n\n");

    expect(compiled.prompt).toBe(expected);
  });

  it("embeds every included section verbatim in the prompt", () => {
    writeFileSync(join(workspace, "SOUL.md"), "# Soul\nBe kind.");
    writeFileSync(join(workspace, "TOOLS.md"), "# Tools\nUse ssh.");
    const today = formatDate(new Date());
    writeFileSync(join(workspace, "memory", `${today}.md`), "- did a thing");

    const compiled = compileSystemPrompt(makeConfig(), workspace);

    const included = compiled.sections.filter((s) => s.included);
    expect(included.map((s) => s.key)).toEqual(["identity", "SOUL.md", "TOOLS.md", `memory/${today}.md`]);
    for (const section of included) {
      expect(compiled.prompt).toContain(section.content);
      expect(section.chars).toBe(section.content.length);
      expect(section.estTokens).toBe(Math.round(section.chars / 4));
    }
  });

  it("lists missing or empty files as not included and omits them from the prompt", () => {
    writeFileSync(join(workspace, "USER.md"), "   \n  ");

    const compiled = compileSystemPrompt(makeConfig(), workspace);

    const user = compiled.sections.find((s) => s.key === "USER.md");
    expect(user).toMatchObject({ included: false, content: "", chars: 0, estTokens: 0 });
    const heartbeat = compiled.sections.find((s) => s.key === "HEARTBEAT.md");
    expect(heartbeat?.included).toBe(false);
    expect(compiled.prompt).not.toContain("USER.md");
  });

  it("always lists the identity section plus core files and two journal days", () => {
    const compiled = compileSystemPrompt(makeConfig(), workspace);

    // identity + 5 core files + today + yesterday
    expect(compiled.sections).toHaveLength(8);
    expect(compiled.sections[0].key).toBe("identity");
    expect(compiled.sections[0].source).toBe("agent.json");
    expect(compiled.sections.filter((s) => s.source === "memory-journal")).toHaveLength(2);
  });

  it("measures totals on the assembled prompt, not the sum of sections", () => {
    writeFileSync(join(workspace, "SOUL.md"), "soul content");
    writeFileSync(join(workspace, "MEMORY.md"), "memory content");

    const compiled = compileSystemPrompt(makeConfig(), workspace);

    expect(compiled.totalChars).toBe(compiled.prompt.length);
    expect(compiled.totalEstTokens).toBe(Math.round(compiled.prompt.length / 4));
    // Joiners and the workspace header mean the total exceeds the section sum minus identity
    const sectionSum = compiled.sections.reduce((acc, s) => acc + s.chars, 0);
    expect(compiled.totalChars).toBeGreaterThan(sectionSum);
  });

  it("returns an empty prompt for a blank config and empty workspace", () => {
    const compiled = compileSystemPrompt(makeConfig({ name: "", role: undefined }), workspace);

    expect(compiled.prompt).toBe("");
    expect(compiled.totalChars).toBe(0);
    expect(compiled.sections.every((s) => !s.included)).toBe(true);
  });
});
