/**
 * `ingest_logs` is callboard's own audit channel to drawlatch (audit-log.ts).
 * An agent must never reach it: drawlatch stamps the authenticated caller on
 * every record, so an agent holding the tool could write records under its
 * chat's caller at will. Pin both the advertised surface and where each
 * handler actually sends.
 */
import { describe, expect, it, vi } from "vitest";

const callTool = vi.fn(async () => ({}));
vi.mock("./proxy-singleton.js", () => ({ getProxy: () => ({ callTool }) }));

const { buildProxyToolsSpec } = await import("./proxy-tools.js");

describe("agent-facing proxy tools", () => {
  it("do not advertise ingest_logs", () => {
    const names = buildProxyToolsSpec("default").tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain("ingest_logs");
  });

  it("no handler forwards to ingest_logs, whatever its input", async () => {
    const tools = buildProxyToolsSpec("default").tools;
    for (const tool of tools) {
      // An input that tries to name the tool — every handler must ignore it.
      await (tool.handler as (input: unknown) => Promise<unknown>)({ toolName: "ingest_logs", tool: "ingest_logs", name: "ingest_logs", method: "GET", url: "https://x" }).catch(() => {});
    }
    const forwarded = callTool.mock.calls.map((c) => (c as unknown[])[0]);
    expect(forwarded.length).toBe(tools.length);
    expect(forwarded).not.toContain("ingest_logs");
  });
});
