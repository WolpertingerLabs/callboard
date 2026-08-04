import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-pi-adapter-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { PiAdapter, collectPiToolSpecs, resolvePiSessionsRoot } = await import("./PiAdapter.js");
const { defineTool } = await import("../../ports/tools.js");
const { PiAgentQuery } = await import("./PiAgentQuery.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const spec = {
  name: "callboard",
  version: "1.0.0",
  tools: [defineTool("set_chat_title", "Set the title", { title: z.string() }, async () => ({ content: [{ type: "text", text: "ok" }] }))],
};

describe("PiAdapter", () => {
  it("identifies as pi", () => {
    expect(new PiAdapter().kind).toBe("pi");
  });

  it("returns a query synchronously, without doing async setup", () => {
    // Deferred construction: `query()` must not touch the network, the model
    // catalog or the filesystem — everything happens on first iteration.
    const query = new PiAdapter().query({ prompt: "hi", options: { cwd: tmpRoot } });
    expect(query).toBeInstanceOf(PiAgentQuery);
    expect(typeof query.close).toBe("function");
  });

  it("mints a distinct session id per query", () => {
    const adapter = new PiAdapter();
    const a = adapter.query({ prompt: "hi", options: {} }) as unknown as { opts: { sessionId: string } };
    const b = adapter.query({ prompt: "hi", options: {} }) as unknown as { opts: { sessionId: string } };
    expect(a.opts.sessionId).not.toBe(b.opts.sessionId);
  });

  it("threads cwd, resume and the pi options block into the query", () => {
    const query = new PiAdapter().query({
      prompt: "hi",
      options: { cwd: "/tmp/work", resume: "/tmp/sessions/abc.jsonl", pi: { providerId: "openrouter", model: "google/gemini-3.6-flash" } },
    }) as unknown as { opts: Record<string, unknown> };
    expect(query.opts.cwd).toBe("/tmp/work");
    expect(query.opts.resumePath).toBe("/tmp/sessions/abc.jsonl");
    expect(query.opts.pi).toMatchObject({ providerId: "openrouter", model: "google/gemini-3.6-flash" });
  });

  it("falls back to process.cwd() when no cwd is given", () => {
    const query = new PiAdapter().query({ prompt: "hi", options: {} }) as unknown as { opts: { cwd: string } };
    expect(query.opts.cwd).toBe(process.cwd());
  });

  it("carries canUseTool and getPermissions into the permission context", () => {
    const canUseTool = async () => ({ behavior: "allow" as const });
    const getPermissions = () => null;
    const query = new PiAdapter().query({
      prompt: "hi",
      options: { canUseTool, pi: { getPermissions } },
    }) as unknown as { opts: { permissions: Record<string, unknown> } };
    expect(query.opts.permissions.canUseTool).toBe(canUseTool);
    expect(query.opts.permissions.getPermissions).toBe(getPermissions);
  });

  it("omits the permission wiring entirely when none was supplied", () => {
    // Absent rather than undefined, so the gate's own `!ctx.canUseTool` check
    // reads the intended thing.
    const query = new PiAdapter().query({ prompt: "hi", options: {} }) as unknown as { opts: { permissions: object } };
    expect(query.opts.permissions).toEqual({});
  });
});

describe("buildToolServer", () => {
  it("returns the spec unchanged — the tools cannot be built until query time", () => {
    // They need the turn's permission context, and their names must reach
    // `buildToolFilters` so a narrowed allowlist does not delete them.
    expect(new PiAdapter().buildToolServer(spec)).toBe(spec);
  });
});

describe("collectPiToolSpecs", () => {
  it("recovers the specs claude.ts stashed in options.mcpServers", () => {
    expect(collectPiToolSpecs({ callboard: spec })).toEqual([spec]);
  });

  it("ignores entries that are not tool specs", () => {
    expect(collectPiToolSpecs({ callboard: spec, other: { command: "npx", args: [] }, nope: null })).toEqual([spec]);
  });

  it.each([[null], [undefined], ["string"], [42]])("returns empty for %s", (value) => {
    expect(collectPiToolSpecs(value)).toEqual([]);
  });

  it("reaches the query as toolSpecs", () => {
    const query = new PiAdapter().query({ prompt: "hi", options: { mcpServers: { callboard: spec } } }) as unknown as {
      opts: { toolSpecs: unknown[] };
    };
    expect(query.opts.toolSpecs).toEqual([spec]);
  });
});

describe("resolvePiSessionsRoot", () => {
  it("sits under the callboard data dir, so CALLBOARD_DATA_DIR moves it", () => {
    expect(resolvePiSessionsRoot()).toBe(join(tmpRoot, "pi-sessions"));
  });

  it("is a function, not a module const — #302", () => {
    expect(typeof resolvePiSessionsRoot).toBe("function");
  });
});

describe("close()", () => {
  it("is idempotent and safe before the session exists", async () => {
    const query = new PiAdapter().query({ prompt: "hi", options: {} });
    await expect(query.close()).resolves.toBeUndefined();
    await expect(query.close()).resolves.toBeUndefined();
  });

  it("closes immediately when handed an already-aborted signal", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const query = new PiAdapter().query({ prompt: "hi", options: { abortController } });
    await expect(query.close()).resolves.toBeUndefined();
  });
});

describe("accountInfo", () => {
  it("reports nothing — pi authenticates per session, not per account", async () => {
    await expect(new PiAdapter().query({ prompt: "hi", options: {} }).accountInfo()).resolves.toBeNull();
  });
});

describe("supportedModels", () => {
  it("answers from the offline catalog for the configured provider", async () => {
    const query = new PiAdapter().query({ prompt: "hi", options: { pi: { providerId: "openrouter" } } });
    const models = await query.supportedModels();
    expect(models.length).toBeGreaterThan(100);
  });

  it("defaults to openrouter when no provider is configured", async () => {
    const models = await new PiAdapter().query({ prompt: "hi", options: {} }).supportedModels();
    expect(models.length).toBeGreaterThan(100);
  });
});
