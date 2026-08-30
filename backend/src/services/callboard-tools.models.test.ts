/**
 * `list_codex_models` and `list_openrouter_models` after the `search_*` tools
 * were folded into them.
 *
 * The thing worth pinning is the dual default, which is the one piece of
 * genuinely new logic: an unfiltered call is a *catalog* and returns
 * everything, a filtered call is a *lookup* and stops at 50 — and an explicit
 * `limit` beats both. Those three paths were two separate tools with two
 * separate defaults before, so collapsing them is exactly where a default can
 * be silently lost.
 *
 * The subsequence matcher itself is NOT re-tested here; it is unchanged and
 * covered by codex-models.test.ts / openrouter-models.test.ts. These tests
 * assert the routing instead: which branch runs, and what limit it is handed.
 *
 * Both catalog modules are partially mocked (real module via importOriginal,
 * with the two entry points overridden) so the tools read a fixed synthetic
 * catalog instead of whatever the live cache holds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "../agents/ports/tools.js";

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-tools-models-"));

// The same cycle break the other callboard-tools tests use: callboard-tools
// imports claude.ts, which registers back into it at module load.
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined, getPendingRequest: () => null }));

/** A catalog comfortably larger than the 50-result query default. */
const CODEX_CATALOG = Array.from({ length: 120 }, (_, i) => ({ id: `gpt-${i}`, name: `GPT ${i}` }));
const OPENROUTER_CATALOG = Array.from({ length: 120 }, (_, i) => ({
  id: `vendor/model-${i}`,
  name: `Model ${i}`,
  promptPrice: "0.000001",
  completionPrice: "0.000002",
}));

const searchCodex = vi.fn(async (_query: string, limit = 50) => CODEX_CATALOG.slice(0, Math.max(1, limit)));
const searchOpenRouter = vi.fn(async (_query: string, limit = 50) => OPENROUTER_CATALOG.slice(0, Math.max(1, limit)));

vi.mock("./codex-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./codex-models.js")>()),
  getVisibleCodexModelsAsync: async () => CODEX_CATALOG,
  searchCodexModels: (query: string, limit?: number) => searchCodex(query, limit),
}));

vi.mock("./openrouter-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openrouter-models.js")>()),
  getOpenRouterModelsAsync: async () => OPENROUTER_CATALOG,
  searchOpenRouterModels: (query: string, limit?: number) => searchOpenRouter(query, limit),
}));

const { buildCallboardToolsSpec } = await import("./callboard-tools.js");

function tool(name: string): ToolDefinition<any> {
  const spec = buildCallboardToolsSpec(() => "chat-under-test", undefined, { includeJobTools: false });
  const found = spec.tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found as ToolDefinition<any>;
}

/** The single text block every one of these tools returns, parsed. */
async function call(name: string, args: Record<string, unknown>) {
  const result: { content: Array<{ type: string; text?: string }> } = await tool(name).handler(args);
  return JSON.parse(result.content[0].text!);
}

beforeEach(() => {
  searchCodex.mockClear();
  searchOpenRouter.mockClear();
});

describe("the search_* model tools are gone, folded into their list_* siblings", () => {
  it("registers neither search_codex_models nor search_openrouter_models", () => {
    const names = buildCallboardToolsSpec(() => "chat-under-test", undefined, { includeJobTools: false }).tools.map((t) => t.name);
    expect(names).not.toContain("search_codex_models");
    expect(names).not.toContain("search_openrouter_models");
    expect(names).toEqual(expect.arrayContaining(["list_codex_models", "list_openrouter_models"]));
  });
});

describe("list_codex_models", () => {
  it("returns the whole catalog when no query and no limit are given", async () => {
    const payload = await call("list_codex_models", {});
    expect(payload.count).toBe(120);
    expect(payload.total).toBe(120);
    expect(payload.query).toBeUndefined();
    // The unfiltered branch must not detour through the search path at all.
    expect(searchCodex).not.toHaveBeenCalled();
  });

  it("defaults a query to 50 results — the old search_codex_models default", async () => {
    const payload = await call("list_codex_models", { query: "g5" });
    expect(searchCodex).toHaveBeenCalledWith("g5", 50);
    expect(payload.count).toBe(50);
    expect(payload.query).toBe("g5");
    // `total` still describes the catalog, not the match set.
    expect(payload.total).toBe(120);
  });

  it("lets an explicit limit override the query default", async () => {
    const payload = await call("list_codex_models", { query: "g5", limit: 7 });
    expect(searchCodex).toHaveBeenCalledWith("g5", 7);
    expect(payload.count).toBe(7);
  });

  it("lets an explicit limit truncate an unfiltered listing", async () => {
    const payload = await call("list_codex_models", { limit: 3 });
    expect(payload.count).toBe(3);
    expect(payload.total).toBe(120);
    expect(searchCodex).not.toHaveBeenCalled();
  });

  it("treats an empty query as a query, not as an absent one", async () => {
    // "" is falsy but present — routing on `!== undefined` is what keeps this
    // a 50-capped lookup rather than a full catalog dump.
    const payload = await call("list_codex_models", { query: "" });
    expect(searchCodex).toHaveBeenCalledWith("", 50);
    expect(payload.count).toBe(50);
  });
});

describe("list_openrouter_models", () => {
  it("returns the whole catalog when no query and no limit are given", async () => {
    const payload = await call("list_openrouter_models", {});
    expect(payload.count).toBe(120);
    expect(payload.total).toBe(120);
    expect(payload.pricingUnit).toBe("per 1M tokens");
    expect(searchOpenRouter).not.toHaveBeenCalled();
  });

  it("defaults a query to 50 results — the old search_openrouter_models default", async () => {
    const payload = await call("list_openrouter_models", { query: "vm1" });
    expect(searchOpenRouter).toHaveBeenCalledWith("vm1", 50);
    expect(payload.count).toBe(50);
    expect(payload.query).toBe("vm1");
  });

  it("lets an explicit limit override the query default", async () => {
    const payload = await call("list_openrouter_models", { query: "vm1", limit: 4 });
    expect(searchOpenRouter).toHaveBeenCalledWith("vm1", 4);
    expect(payload.count).toBe(4);
  });

  it("lets an explicit limit truncate an unfiltered listing", async () => {
    const payload = await call("list_openrouter_models", { limit: 2 });
    expect(payload.count).toBe(2);
    expect(payload.total).toBe(120);
    expect(searchOpenRouter).not.toHaveBeenCalled();
  });

  it("no longer returns the vestigial alias block on either branch", async () => {
    // The deprecated OpenRouter-only alias map is not read any more; aliases
    // are list_model_aliases' job.
    expect(await call("list_openrouter_models", {})).not.toHaveProperty("aliases");
    expect(await call("list_openrouter_models", { query: "vm1" })).not.toHaveProperty("aliases");
  });

  it("still prices every row", async () => {
    const payload = await call("list_openrouter_models", { limit: 1 });
    expect(payload.models[0]).toMatchObject({ id: "vendor/model-0", in: "$1", out: "$2" });
  });
});
