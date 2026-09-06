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
 * Custom-tool bridge, not native MCP registration. Host-provided handlers may
 * proxy the common MCP service; this adapter owns only schema/result/context
 * translation. Cline 0.0.82's gateway recognizes text/image arrays as content,
 * with image `mediaType` (not MCP's `mimeType`). Never stringify those bytes.
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
import type { ToolResultContent } from "@cline/shared";
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
    retryable: false,
    maxRetries: 0,
    execute: async (input: unknown, context) => {
      const result = await def.handler(input as never, { signal: context.signal, toolCallId: context.toolCallId });
      return renderToolResult(result);
    },
  }) as AgentTool;
}

/** Text-only results retain their historical string form; images use the SDK's
 * supported multimodal array, which its gateway serializes as media content. */
export function renderToolResult(result: ToolCallResult): ToolResultContent["content"] {
  const content = result.content.map((block) => block.type === "image"
    ? { type: "image" as const, data: block.data, mediaType: block.mimeType }
    : { type: "text" as const, text: block.text });
  const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (result.isError) throw new Error(text || "Tool call failed");
  return content.some((block) => block.type === "image") ? content : text;
}
