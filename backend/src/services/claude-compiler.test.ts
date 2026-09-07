import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSystemPrompt, compileIdentityPrompt, compileWorkspaceContext, DEFAULT_JOURNAL_TOKEN_BUDGET } from "./claude-compiler.js";
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

describe("journal token budget", () => {
  let workspace: string;

  /** A journal whose every line is identifiable, sized well past any budget under test */
  function writeJournal(date: string, lineCount: number): void {
    const lines = Array.from({ length: lineCount }, (_, i) => `- entry ${i} ${"x".repeat(80)}`);
    writeFileSync(join(workspace, "memory", `${date}.md`), lines.join("\n"));
  }

  function yesterdayKey(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return formatDate(d);
  }

  function sectionFor(compiled: ReturnType<typeof compileSystemPrompt>, date: string) {
    return compiled.sections.find((s) => s.key === `memory/${date}.md`);
  }

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "claude-compiler-budget-"));
    mkdirSync(join(workspace, "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("trims a previous day's journal to the configured budget", () => {
    writeJournal(yesterdayKey(), 500);

    const compiled = compileSystemPrompt(makeConfig({ journalTokenBudget: 200 }), workspace);
    const section = sectionFor(compiled, yesterdayKey());

    expect(section?.truncated).toBe(true);
    // 200 tokens ≈ 800 chars; allow the notice and the header line on top
    expect(section?.chars).toBeLessThan(200 * 4 + 500);
  });

  it("keeps the tail of a trimmed journal and drops the start", () => {
    writeJournal(yesterdayKey(), 500);

    const compiled = compileSystemPrompt(makeConfig({ journalTokenBudget: 200 }), workspace);
    const content = sectionFor(compiled, yesterdayKey())?.content ?? "";

    expect(content).toContain("entry 499");
    expect(content).not.toContain("entry 0 ");
  });

  it("tells the agent how to recover the omitted entries", () => {
    const date = yesterdayKey();
    writeJournal(date, 500);

    const compiled = compileSystemPrompt(makeConfig({ journalTokenBudget: 200 }), workspace);
    const content = sectionFor(compiled, date)?.content ?? "";

    expect(content).toContain(`memory/${date}.md`);
    expect(content).toMatch(/read .* or search it/i);
  });

  it("never truncates today's journal", () => {
    const today = formatDate(new Date());
    writeJournal(today, 500);

    const compiled = compileSystemPrompt(makeConfig({ journalTokenBudget: 200 }), workspace);
    const section = sectionFor(compiled, today);

    expect(section?.truncated).toBeUndefined();
    expect(section?.content).toContain("entry 0 ");
    expect(section?.content).toContain("entry 499");
  });

  it("never truncates MEMORY.md, however large", () => {
    const memory = Array.from({ length: 500 }, (_, i) => `- fact ${i} ${"y".repeat(80)}`).join("\n");
    writeFileSync(join(workspace, "MEMORY.md"), memory);

    const compiled = compileSystemPrompt(makeConfig({ journalTokenBudget: 200 }), workspace);
    const section = compiled.sections.find((s) => s.key === "MEMORY.md");

    expect(section?.truncated).toBeUndefined();
    expect(section?.content).toContain("fact 0 ");
    expect(section?.content).toContain("fact 499");
  });

  it("treats a budget of 0 as unlimited", () => {
    writeJournal(yesterdayKey(), 500);

    const compiled = compileSystemPrompt(makeConfig({ journalTokenBudget: 0 }), workspace);
    const section = sectionFor(compiled, yesterdayKey());

    expect(section?.truncated).toBeUndefined();
    expect(section?.content).toContain("entry 0 ");
  });

  it("applies the default budget when the agent has not set one", () => {
    writeJournal(yesterdayKey(), 4000);

    const compiled = compileSystemPrompt(makeConfig(), workspace);
    const section = sectionFor(compiled, yesterdayKey());

    expect(section?.truncated).toBe(true);
    expect(section?.estTokens).toBeLessThan(DEFAULT_JOURNAL_TOKEN_BUDGET * 1.2);
  });

  it("leaves a journal that fits the budget completely untouched", () => {
    writeJournal(yesterdayKey(), 5);

    const compiled = compileSystemPrompt(makeConfig({ journalTokenBudget: 200 }), workspace);
    const section = sectionFor(compiled, yesterdayKey());

    expect(section?.truncated).toBeUndefined();
    expect(section?.content).toContain("entry 0 ");
    expect(section?.content).toContain("entry 4 ");
  });

  it("cuts on a line boundary so no entry is embedded half-written", () => {
    writeJournal(yesterdayKey(), 500);

    const compiled = compileSystemPrompt(makeConfig({ journalTokenBudget: 200 }), workspace);
    const content = sectionFor(compiled, yesterdayKey())?.content ?? "";

    // Every surviving journal line is a whole entry, not a fragment of one
    const entryLines = content.split("\n").filter((l) => l.includes("entry "));
    expect(entryLines.length).toBeGreaterThan(0);
    for (const line of entryLines) {
      expect(line).toMatch(/^- entry \d+ x{80}$/);
    }
  });
});
