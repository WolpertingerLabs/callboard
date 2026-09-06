import { isComputerControlToolName } from "../../permissions/computerControl.js";
import type { AnyToolDefinition, ToolServerSpec } from "../../ports/tools.js";

// Cline retains extraTools across send(). Managed wrappers must not retain the
// first turn's principal/connection. Only the current turn's host-owned handler
// may dispatch; an idle resident session has no authority to call these tools.
const turns = new Map<string, { tools: Map<string, AnyToolDefinition>; signal: AbortSignal }>();
export function bindManagedClineTools(sessionId: string, specs: ToolServerSpec[], signal: AbortSignal): { specs: ToolServerSpec[]; release: () => void } {
  const tools = new Map<string, AnyToolDefinition>();
  for (const spec of specs) for (const def of spec.tools) {
    if (!isComputerControlToolName(def.name)) continue;
    if (tools.has(def.name)) throw new Error(`Duplicate managed tool: ${def.name}`);
    tools.set(def.name, def);
  }
  const turn = { tools, signal };
  if (turns.has(sessionId)) throw new Error("Managed Cline turn is already active");
  turns.set(sessionId, turn);
  return {
    specs: specs.map((spec) => ({
      ...spec,
      tools: spec.tools.map((def) => {
        if (!isComputerControlToolName(def.name)) return def;
        const name = def.name; // Resident closure must not retain the old handler/client.
        return {
          ...def,
          handler: async (args, context) => {
            const current = turns.get(sessionId);
            const target = current?.tools.get(name);
            if (!current || !target) throw new Error("Managed tool has no active turn binding");
            const signal = context?.signal ? AbortSignal.any([current.signal, context.signal]) : current.signal;
            signal.throwIfAborted();
            return target.handler(args, { ...context, signal });
          },
        };
      }),
    })),
    release: () => { if (turns.get(sessionId) === turn) turns.delete(sessionId); },
  };
}
