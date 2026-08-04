/**
 * Tool adapter: callboard {@link ToolServerSpec} → pi `ToolDefinition[]`.
 *
 * ## The shim that isn't here
 *
 * Codex and every ACP vendor are MCP *clients*: they spawn their tool servers
 * themselves, so `adapters/codex/mcp-server-shim.ts` and its ACP twin have to
 * host callboard's tools on a private socket and hand the agent a relay binary.
 * Without that, a callboard tool would run in a fresh child with empty module
 * state and lose the per-chat SSE emitter and every in-memory job run.
 *
 * pi needs none of it. `customTools` is an in-process array, so handlers keep
 * live backend state by simply being closures — the same property the Claude
 * Code, OpenRouter and Cline adapters enjoy.
 *
 * ## Zod → typebox, in practice: it is JSON Schema on both ends
 *
 * The plan called this file's job "Zod→typebox conversion" and named it the new
 * impedance mismatch. It is milder than that, for a reason worth writing down:
 * **typebox schemas are plain JSON Schema objects at runtime.** `TSchema` is a
 * TypeScript-level brand over an ordinary object; typebox's `Type.Object(...)`
 * returns `{ type: "object", properties: {...}, required: [...] }` and nothing
 * more. So the conversion is Zod → JSON Schema, which Zod 4 does natively via
 * {@link z.toJSONSchema}, and the result is structurally a `TSchema`.
 *
 * The spike confirmed the end of that chain by running it: a hand-written
 * JSON-Schema-shaped object passed as `parameters` was advertised to the model,
 * called with well-formed arguments, and executed.
 *
 * Measured against callboard's *real* tool specs rather than a toy — the
 * constructs actually in use are `string`, `number` (with `.min`/`.max`),
 * `boolean`, `enum`, `any`, `unknown`, `record`, `array`, nested `object`, plus
 * `.optional()` and `.describe()`. Every one survives:
 *
 * ```
 * z.any()                      → {}
 * z.record(z.string(), z.any()) → { type:"object", propertyNames:{type:"string"}, additionalProperties:{} }
 * z.number().min(1).max(10)     → { type:"number", minimum:1, maximum:10 }
 * z.string().optional()         → property present, name absent from `required`
 * ```
 *
 * `toolAdapter.test.ts` runs this over every spec the backend registers, so a
 * future tool using a construct that does not survive fails there rather than
 * silently reaching the model with a broken schema. **No Zod construct currently
 * in callboard's tool surface is lost.**
 *
 * ## Plain JSON Schema is a supported input, not a lucky accident
 *
 * `pi-ai`'s `validateToolArguments` branches on whether the schema carries
 * typebox's `TYPEBOX_KIND` symbol:
 *
 * ```js
 * if (!Object.getOwnPropertySymbols(tool.parameters).includes(TYPEBOX_KIND)) {
 *   const coerced = coerceWithJsonSchema(args, tool.parameters);
 *   …
 * }
 * ```
 *
 * A plain object has no such symbol, so pi takes the `coerceWithJsonSchema`
 * path — which exists precisely to handle schemas that are JSON Schema rather
 * than typebox. So this adapter is on a designed-for route, not squeezing
 * through a gap.
 *
 * **pi does validate**, contrary to a first reading of the loop: it coerces with
 * `Value.Convert`, checks, and *throws* a formatted error on failure, which
 * `prepareToolCall` turns into an error tool result. So the handler never sees
 * arguments that violate the advertised schema.
 *
 * What pi cannot check is anything the Zod→JSON-Schema conversion cannot
 * express — `.refine()`, `.transform()`, custom `superRefine` predicates. None
 * are in callboard's tool surface today, but `defineTool` accepts them and the
 * handler is typed `z.output<…>` as though they held. So {@link translateToolDef}
 * still parses with the tool's own Zod shape: redundant for the constructs that
 * survive, and the only check at all for the ones that do not.
 *
 * ## Failure is signalled by throwing, not by a flag
 *
 * `AgentToolResult` is `{ content, details, usage?, addedToolNames? }` — there is
 * **no `isError` field**. The `isError: true` that appears on
 * `tool_execution_end` is set by the agent loop's `catch`, which wraps a thrown
 * error into `createErrorToolResult(message)`.
 *
 * A tool that *returned* `{ isError: true }` would therefore be recorded as a
 * success with a stray property, and callboard's `tool_result.isError` would
 * never be set — a failed tool rendering green. So {@link renderToolResult}
 * throws, the same convention `cline/toolAdapter.ts` and
 * `openrouter/toolAdapter.ts` use.
 *
 * ## Naming is load-bearing
 *
 * `def.name` passes through unprefixed, exactly as the OpenRouter and Cline
 * bridges do. That bare name is what `tool_call` reports and what
 * `categorizePiToolName` gates on, so the names {@link buildPiTools} returns must
 * be the same ones `buildToolFilters` is given — see `PiAgentQuery.iterate`,
 * which is the only place that pairs them.
 *
 * @see plans/pi-adapter.md
 * @see plans/pi-spike-findings.md (§3 — `tools` is an allowlist over customTools too)
 */
import { z } from "zod";
import type { ToolDefinition as PiToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AnyToolDefinition, ToolCallResult, ToolContentBlock, ToolServerSpec } from "../../ports/tools.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("pi-tools");

/**
 * A built tool bundle: the pi tools plus the names they registered under.
 *
 * The names travel with the tools rather than being recomputed by the caller,
 * because the one thing that must never drift is "the allowlist knows every name
 * that was registered" — a callboard tool missing from `tools` is invisible to
 * the model (§3), and one missing from the gate's view is ungated.
 */
export interface PiToolBundle {
  tools: PiToolDefinition[];
  names: string[];
}

/** Build pi `ToolDefinition`s from a neutral {@link ToolServerSpec}. */
export function buildPiTools(spec: ToolServerSpec): PiToolBundle {
  return {
    tools: spec.tools.map(translateToolDef),
    names: spec.tools.map((t) => t.name),
  };
}

/**
 * Convert a callboard `ZodRawShape` into the JSON Schema pi advertises.
 *
 * `io: "input"` matters: callboard handlers receive the *input* side of the
 * schema (what the model sends), not the parsed output, so a schema with
 * defaults or transforms must describe what is accepted rather than what is
 * produced.
 *
 * `$schema` is stripped. typebox schemas do not carry it, and it is metadata for
 * a validator rather than something a provider's tool-schema field wants.
 */
export function toolParametersFromShape(shape: z.ZodRawShape): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape), { io: "input" }) as Record<string, unknown>;
  const { $schema: _dropped, ...rest } = schema;
  return rest;
}

function translateToolDef(def: AnyToolDefinition): PiToolDefinition {
  const validator = z.object(def.inputSchema);

  return {
    name: def.name,
    // Required by pi's `ToolDefinition`, and used only for display. The tool
    // name is the honest label; callboard's specs carry no separate title.
    label: def.name,
    description: def.description,
    parameters: toolParametersFromShape(def.inputSchema) as PiToolDefinition["parameters"],
    execute: async (_toolCallId: string, params: unknown) => {
      // Second line of defence, for the Zod constructs JSON Schema cannot carry.
      // Throwing is how pi is told a call failed — the loop catches it and sets
      // `isError` on `tool_execution_end`.
      const parsed = validator.safeParse(params ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        log.warn(`tool ${def.name} called with arguments that failed its schema — ${detail}`);
        throw new Error(`Invalid arguments for ${def.name}: ${detail}`);
      }

      // A throwing handler is left to propagate: pi's `executePreparedToolCall`
      // wraps it into an error result, so the model sees the message and can
      // adjust. Catching it here to return a value would report the failure as a
      // success.
      return renderToolResult(await def.handler(parsed.data as never));
    },
  } as PiToolDefinition;
}

/**
 * Translate a callboard {@link ToolCallResult} into pi's `AgentToolResult`.
 *
 * Content is very nearly an identity map, which is a genuine improvement over
 * the Cline bridge: pi's `ImageContent` is `{ type: "image", data, mimeType }` —
 * exactly callboard's own image block — so an image-returning tool survives
 * intact instead of being flattened to an `[image:<mime>]` placeholder.
 *
 * **`isError` throws rather than being returned.** `AgentToolResult` has no such
 * field; returning one would record a failed tool as a success. See the header.
 *
 * `details` is pi's slot for structured, non-model-facing data. Callboard's tool
 * contract has no equivalent, so it is `{}` — pi's own `createErrorToolResult`
 * uses the same empty object rather than `undefined`.
 */
export function renderToolResult(result: ToolCallResult): {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details: Record<string, never>;
} {
  const content = (result?.content ?? []).map(translateContentBlock);

  if (result?.isError) {
    const text = content
      .map((b) => (b.type === "text" ? b.text : `[image:${b.mimeType}]`))
      .join("\n")
      .trim();
    throw new Error(text || "Tool call failed");
  }

  return {
    // pi renders an empty content array as a blank result; a tool that returned
    // nothing is better described as having said so.
    content: content.length > 0 ? content : [{ type: "text" as const, text: "" }],
    details: {},
  };
}

function translateContentBlock(block: ToolContentBlock): { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } {
  return block.type === "image" ? { type: "image", data: block.data, mimeType: block.mimeType } : { type: "text", text: block.text };
}
