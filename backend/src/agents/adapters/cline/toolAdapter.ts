/**
 * Tool adapter: callboard {@link ToolServerSpec} → Cline `AgentTool[]`.
 *
 * ## The shim that isn't here
 *
 * Codex and every ACP vendor are MCP *clients*: they spawn their tool servers
 * themselves, so `adapters/codex/mcp-server-shim.ts` and its ACP twin have to
 * host callboard's tools on a private socket in the backend process and hand the
 * agent a relay binary to launch. Without that, a callboard tool would run in a
 * fresh child with empty module state and lose the per-chat SSE emitter, the
 * registered `sendMessage`, and every in-memory job run.
 *
 * Cline needs none of it. `CoreSessionConfig.extraTools` takes an in-process
 * array of `AgentTool`, so handlers keep live backend state by simply being
 * closures — the same property the Claude Code and OpenRouter adapters enjoy.
 * That is one of the three reasons the plan chose the SDK over `cline --acp`.
 *
 * ## The two impedance mismatches
 *
 * 1. **Schema shape.** Callboard tools carry a `ZodRawShape` (a bare object of
 *    field schemas); Cline's `createTool` wants a complete Zod type. Wrap in
 *    `z.object()`.
 * 2. **Result shape.** Callboard returns `{ content: ToolContentBlock[],
 *    isError? }`; Cline's `execute` returns a value the runtime records as the
 *    tool's output. Flatten to a single string, and signal failure by throwing —
 *    the same convention `openrouter/toolAdapter.ts` uses, and what surfaces as
 *    `content_end.error` on the event stream.
 *
 * Images become a stable `[image:<mime>]` placeholder. Callboard's current tools
 * all return text/JSON, so nothing is lost in practice; revisit if an
 * image-returning tool lands.
 *
 * ## Naming is load-bearing
 *
 * `def.name` passes through unprefixed, exactly as the OpenRouter bridge does.
 * That bare name is what `requestToolApproval` reports and what
 * `categorizeClineToolName` gates on, so {@link buildClineTools} and
 * `buildClineToolPolicies` must be given the *same* names — see
 * `ClineAdapter.buildToolServer`, which is the only place that pairs them.
 *
 * @see plans/cline-adapter.md
 * @see ../openrouter/toolAdapter.ts (the in-process precedent)
 */
import { z } from "zod";
import { createTool, type AgentTool } from "@cline/sdk";
import type { AnyToolDefinition, ToolCallResult, ToolServerSpec } from "../../ports/tools.js";

/**
 * A built tool bundle: the Cline tools plus the names they registered under.
 *
 * The names travel with the tools rather than being recomputed by the caller,
 * because the one thing that must never drift is "every registered tool has a
 * policy entry" — `ToolPolicy` defaults to auto-approved, so a name known to the
 * runtime but not to the policy map is an ungated tool.
 */
export interface ClineToolBundle {
  tools: AgentTool[];
  names: string[];
}

/** Build Cline `AgentTool`s from a neutral {@link ToolServerSpec}. */
export function buildClineTools(spec: ToolServerSpec): ClineToolBundle {
  const tools = spec.tools.map(translateToolDef);
  return { tools, names: spec.tools.map((t) => t.name) };
}

function translateToolDef(def: AnyToolDefinition): AgentTool {
  return createTool({
    name: def.name,
    description: def.description,
    // ZodRawShape → ZodObject. `createTool`'s schema overload converts via the
    // SDK's own `zodToJsonSchema`, which needs a fully-shaped Zod type rather
    // than the raw shape callboard's `defineTool` stores.
    inputSchema: z.object(def.inputSchema),
    execute: async (input: unknown) => {
      const result = await def.handler(input as never);
      return renderToolResult(result);
    },
  }) as AgentTool;
}

/**
 * Flatten a callboard {@link ToolCallResult} into a value Cline's runtime can
 * record.
 *
 * Success → a single string. Error → throw with the same stringified payload, so
 * the runtime surfaces it as a failed tool call (`content_end.error`) and the
 * model sees the message rather than a silent empty result.
 */
export function renderToolResult(result: ToolCallResult): string {
  const text = (result?.content ?? [])
    .map((block) => (block.type === "text" ? block.text : `[image:${block.mimeType}]`))
    .join("\n");
  if (result?.isError) throw new Error(text || "Tool call failed");
  return text;
}
