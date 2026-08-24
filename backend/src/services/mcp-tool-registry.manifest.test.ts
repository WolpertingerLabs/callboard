/**
 * The tool manifest is documentation, and documentation drifts silently.
 *
 * `mcp-tool-registry.ts` is a hand-maintained description of tools whose real
 * contract lives in the Zod shapes over in callboard-tools.ts / agent-tools.ts.
 * Nothing has ever tied the two together, so a param could be renamed in the
 * schema and keep its old name in the manifest indefinitely — which is exactly
 * what happened to `talk_to_agent` / `deploy_agent`, documented as taking
 * `targetAgent` while both schemas have always called it `targetAlias`. A user
 * reading the manifest to hand-write a call got a name the tool would reject.
 *
 * This is deliberately not an exhaustiveness check. The manifest is allowed to
 * describe a subset — it is a UI listing, not a generated schema. What it is not
 * allowed to do is name a parameter that does not exist, or disagree about
 * whether one is required. Both of those are checkable, and both are the kind of
 * wrong that only ever gets noticed by someone whose call already failed.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import type { AnyToolDefinition } from "../agents/ports/tools.js";

// A scratch data dir before anything touches `paths.ts` — these spec builders
// read agent config off disk.
process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-manifest-"));

// `claude.ts` and `callboard-tools.ts` are mutually recursive; entering the
// cycle at callboard-tools crashes on the module-scope back-registration.
// Stubbing claude.ts is the cheaper of the two escapes here — none of these
// tools are invoked, only their schemas read.
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));

const { getMcpToolsManifest } = await import("./mcp-tool-registry.js");
const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
const { buildAgentToolsSpec } = await import("./agent-tools.js");

/** Every tool the two documented servers actually register, by name. */
function realTools(): Map<string, AnyToolDefinition> {
  const specs = [
    buildCallboardToolsSpec(
      () => "chat-1",
      () => "agent",
    ),
    buildAgentToolsSpec("agent", () => "chat-1"),
  ];
  const byName = new Map<string, AnyToolDefinition>();
  for (const spec of specs) for (const tool of spec.tools) byName.set(tool.name, tool);
  return byName;
}

/**
 * One entry of a raw Zod shape. `ToolDefinition.inputSchema` is type-erased to
 * `ZodRawShape`, whose values are the core `$ZodType` rather than the `ZodType`
 * the fluent methods hang off — hence the cast in `isRequired`.
 */
type ShapeEntry = z.ZodRawShape[string];

/** A Zod shape entry is required exactly when it rejects `undefined`. */
function isRequired(schema: ShapeEntry): boolean {
  return !(schema as z.ZodTypeAny).safeParse(undefined).success;
}

/** The accepted values of a (possibly `.optional()`-wrapped) `z.enum`, or null. */
function zodEnumOptions(schema: ShapeEntry | undefined): string[] | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = schema;
  while (node?.def?.innerType) node = node.def.innerType;
  const entries = node?.def?.entries;
  return entries ? Object.values(entries as Record<string, string>) : null;
}

describe("the MCP tool manifest matches the schemas it describes", () => {
  // Both contexts, so agent-only tools are covered too.
  const manifest = [...getMcpToolsManifest("chat").tools, ...getMcpToolsManifest("agent").tools];
  const tools = realTools();

  it("describes tools that exist (or are declared by a server this test does not build)", () => {
    // Proxy and external servers are assembled elsewhere and legitimately absent
    // here; the platform/agent tools are the ones this file can check.
    const checkable = manifest.filter((t) => t.serverName === "callboard-tools" || t.serverName === "callboard");
    expect(checkable.length).toBeGreaterThan(20);
    const missing = checkable.filter((t) => !tools.has(t.name)).map((t) => `${t.serverName}/${t.name}`);
    expect(missing).toEqual([]);
  });

  it("names no parameter the schema does not have", () => {
    const phantom: string[] = [];
    for (const entry of manifest) {
      const tool = tools.get(entry.name);
      if (!tool) continue;
      const shape = tool.inputSchema as z.ZodRawShape;
      for (const param of entry.parameters) {
        if (!(param.name in shape)) phantom.push(`${entry.name}.${param.name}`);
      }
    }
    expect(phantom).toEqual([]);
  });

  it("agrees with the schema about which parameters are required", () => {
    const disagreements: string[] = [];
    for (const entry of manifest) {
      const tool = tools.get(entry.name);
      if (!tool) continue;
      const shape = tool.inputSchema as z.ZodRawShape;
      for (const param of entry.parameters) {
        const schema = shape[param.name];
        if (!schema) continue; // already reported by the phantom-param test
        const actual = isRequired(schema);
        if (actual !== !!param.required) {
          disagreements.push(`${entry.name}.${param.name}: manifest says required=${!!param.required}, schema says required=${actual}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("lists the real options wherever it documents an enum", () => {
    // A short enum is the one kind of param a reader will copy verbatim without
    // checking, so a missing member reads as "this value is not allowed".
    const disagreements: string[] = [];
    for (const entry of manifest) {
      const tool = tools.get(entry.name);
      if (!tool) continue;
      const shape = tool.inputSchema as z.ZodRawShape;
      for (const param of entry.parameters) {
        if (!param.enumValues) continue;
        const actual = zodEnumOptions(shape[param.name]);
        if (!actual) continue; // documented as an enum over a non-enum schema — a judgement call, not drift
        if (JSON.stringify([...actual].sort()) !== JSON.stringify([...param.enumValues].sort())) {
          disagreements.push(`${entry.name}.${param.name}: manifest ${JSON.stringify(param.enumValues)} vs schema ${JSON.stringify(actual)}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("lists the real provider set wherever it documents a provider enum", () => {
    // The regression this PR is about, held at the documentation layer too: the
    // manifest advertised claude-code|codex long after three more harnesses
    // landed, so the UI's tool listing under-reported what a session could spawn.
    const providerParams = manifest.flatMap((t) => t.parameters.filter((p) => p.name === "provider").map((p) => [t.name, p] as const));
    expect(providerParams.length).toBeGreaterThan(0);
    for (const [toolName, param] of providerParams) {
      expect(param.enumValues, toolName).toEqual(["claude-code", "codex", "acp", "cline", "pi"]);
    }
  });

  it("does not advertise acp without its caveat", () => {
    // Deliberately the ONLY thing asserted about description text in this file.
    // A manifest description is a compact UI listing and the Zod `.describe()`
    // is the long-form model-facing copy; requiring them to match would be
    // over-fitting, and would make every wording tweak a two-file edit.
    //
    // This one earns its keep because listing `"acp"` is an offer the tool will
    // refuse from all but ACP sessions — an enum member that is conditionally
    // unusable, which is the one case where the value alone actively misleads.
    // Adding it to the enum without the caveat is the same
    // "documented-but-not-how-it-works" drift the rest of this file exists to
    // catch, one layer up.
    for (const entry of manifest) {
      for (const param of entry.parameters) {
        if (!param.enumValues?.includes("acp")) continue;
        // `description` is optional on the type; an absent one fails here too,
        // which is the right answer — offering acp with no explanation at all is
        // the same defect as offering it with an explanation that omits this.
        expect(param.description?.toLowerCase() ?? "", `${entry.name}.${param.name}`).toContain("acp");
      }
    }
  });
});
