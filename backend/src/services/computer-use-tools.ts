/** All five harnesses call the same MCP service, including custom-tool bridges. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defineTool, type ToolCallResult, type ToolServerSpec } from "../agents/ports/tools.js";
import { controlError, controlPrincipal, getComputerUseHost, isConfirmedFailure, logComputerUseFailure, type FailureContext } from "./computer-use.js";

interface TurnBinding {
  token: string;
  signal: AbortSignal;
  getChatId: () => string;
}
const active = new Set<TurnBinding>();
function currentTurn(chatId: string): TurnBinding | undefined {
  return [...active].reverse().find((turn) => !turn.signal.aborted && turn.getChatId() === chatId);
}
/** Fresh turn binding; resident custom-tool closures resolve current authority, not old grants. */
export function beginComputerUseTurn(getChatId: () => string, signal: AbortSignal): () => void {
  const binding = { token: randomUUID(), signal, getChatId };
  active.add(binding);
  return () => {
    active.delete(binding);
    const chatId = getChatId();
    if (!currentTurn(chatId)) {
      const connection = connections.get(chatId);
      connections.delete(chatId);
      if (connection) void connection.then((value) => value.close()).catch(() => {});
    }
  };
}

interface Connection {
  client: Client;
  close(): Promise<void>;
}
const connections = new Map<string, Promise<Connection>>();
async function connection(chatId: string): Promise<Connection> {
  let current = connections.get(chatId);
  if (!current) {
    current = (async () => {
      const host = await getComputerUseHost();
      const { createMcpServer } = await import("@wolpertingerlabs/computer-use");
      const server = createMcpServer(host.service, controlPrincipal(chatId, "agent"));
      const client = new Client({ name: "callboard-computer-use", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      for (const name of ["computer_status", "computer_observe", "computer_act", "computer_stop"]) {
        if (!tools.some((tool) => tool.name === name)) {
          await client.close();
          await server.close();
          throw controlError("unsupported", "Computer MCP manifest is incompatible");
        }
      }
      return {
        client,
        close: async () => {
          await client.close();
          await server.close();
        },
      };
    })().catch((error) => {
      connections.delete(chatId);
      throw error;
    });
    connections.set(chatId, current);
  }
  return current;
}
/** The agent gets the tool result; the operator gets the same failure in the server log. */
const failure = (error: unknown, operation: string, ids: { chatId: string; sessionId?: unknown }, context?: FailureContext): ToolCallResult => {
  logComputerUseFailure(operation, ids, error, context);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: (error as { code?: string }).code ?? "unavailable",
          message: error instanceof Error ? error.message : "Computer control unavailable",
        }),
      },
    ],
  };
};
const text = (value: unknown): ToolCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
/**
 * The MCP layer answers a fault as an `isError` result, not a throw, so nothing
 * above it ever sees an exception. Recover what the operator needs.
 *
 * Exactly two things produce that text on this in-process pair, and both are
 * safe to keep (checked against the SDK, not assumed):
 *
 * - our own handler's `{"error":"<code>"}` envelope (`mcp.ts`), a fixed enum;
 * - the SDK's own argument validation, `MCP error -32602: Input validation
 *   error: …`, which prints the schema and the *names* of the offending keys.
 *
 * Neither can carry page content — the one field that does, `frame.url`, only
 * appears on a success result. So the text is preserved rather than dropped;
 * the logger bounds it and strips its control characters. Anything that is not
 * our envelope came from the SDK refusing the request before our handler ran,
 * which is an `invalid_request`, not a driver fault: `cu_action`'s outer schema
 * is a loose record, so a model can queue an action that only fails validation
 * later, when the human approves it and `computer_act` is finally called.
 */
function mcpFailure(content: unknown[]): Error & { code?: string } {
  const block = content.find((item) => (item as { type?: unknown } | null)?.type === "text") as { text?: unknown } | undefined;
  const raw = typeof block?.text === "string" ? block.text : "";
  let code: string | undefined;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    // Our envelope, but without a string code, is genuinely unknown: stay uncoded so it logs at error.
    if (typeof parsed?.error === "string") code = parsed.error;
  } catch {
    code = raw ? "invalid_request" : undefined;
  }
  // No stack: this failure happened behind the MCP hop, so the extractor's own
  // frames would describe where the text was parsed, not where anything broke —
  // actively misleading now that `escalate` can put this line at error level.
  return Object.assign(new Error(raw || "Driver reported a failure"), { stack: "" }, code ? { code } : {});
}

/**
 * Identity note: the spec is bound to the owning chat through `getChatId`, and
 * every call is authorized and audited as `agent:<that chat>`. Subagents that
 * run inside the parent's turn call this same server and inherit that identity:
 * on Claude Code, Task subagents run in the same CLI process against the same
 * in-process SDK server; on Codex, the tool server is a per-turn socket the
 * native subagents inherit, and exec requests carry no verified caller thread
 * id (see `codex/toolAdapter.ts`). Either way a subagent's `cu_*` calls arrive
 * — and are recorded — as the parent's. `assertNativeAgentControllable` only
 * stops a child chat id from enabling a target on its own; it cannot see this
 * path. The Enable approval text and the panel tell the granting human so, and
 * a subagent's GUI action blocks on a confirmation in the parent chat, which is
 * the chat whose identity it is acting under.
 */
export function buildComputerUseToolsSpec(getChatId: () => string): ToolServerSpec {
  type Context = { signal?: AbortSignal; toolCallId?: string };
  /**
   * `confirmed` marks the one call that is executing a GUI action a human has
   * already said yes to. It is the successor to the `approvedSignal` parameter
   * this replaces, which did two jobs:
   *
   *  1. supply a signal for a call running OUTSIDE the turn, because approval
   *     used to be redeemed later through the panel's approve endpoint;
   *  2. mark that call as post-approval, so its failures escalate.
   *
   * Job 1 is gone: the confirmation now blocks inside the tool call that
   * requested it, so the turn is live and `turn.signal` + `context.signal`
   * already cover cancellation. Job 2 is not gone — a human clicking Confirm
   * and the action then failing is still the failure an operator must see,
   * and it is now the ONLY signal they get, since the human's click returns
   * 200 from `/respond` before anything executes. So the flag survives as a
   * flag.
   */
  async function call(name: string, input: Record<string, unknown>, context?: Context, confirmed?: boolean): Promise<ToolCallResult> {
    // Held outside the try so the catch can tell a stopped turn from a fault:
    // an abort surfaces from the MCP client as a numeric -32001, the same code
    // it uses for a genuine timeout.
    let signal: AbortSignal | undefined;
    // The approved execution is the one path where a human is waiting on the
    // result, so its failures are never routine, whatever code they carry.
    const logContext = (): FailureContext => ({ cancelled: signal?.aborted, escalate: confirmed });
    try {
      const chatId = getChatId();
      const turn = currentTurn(chatId);
      if (!turn || turn.signal.aborted) throw controlError("cancelled", "No active authorized chat turn");
      signal = context?.signal ? AbortSignal.any([turn.signal, context.signal]) : turn.signal;
      signal.throwIfAborted();
      const result = await (await connection(chatId)).client.callTool({ name, arguments: input }, undefined, { signal, timeout: 35_000 });
      signal.throwIfAborted();
      if (currentTurn(chatId)?.token !== turn.token) throw controlError("cancelled", "The chat turn changed");
      const content = Array.isArray(result.content) ? result.content : [];
      if (result.isError) logComputerUseFailure(name, { chatId, sessionId: input.sessionId }, mcpFailure(content), logContext());
      return {
        content: content.flatMap<ToolCallResult["content"][number]>((block) => {
          if (block.type === "text" && typeof block.text === "string") return [{ type: "text" as const, text: block.text }];
          if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")
            return [{ type: "image" as const, data: block.data, mimeType: block.mimeType }];
          return [];
        }),
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (error) {
      return failure(error, name, { chatId: getChatId(), sessionId: input.sessionId }, logContext());
    }
  }
  const ref = { sessionId: z.string().uuid(), generation: z.number().int().positive() };
  return {
    name: "computer_use",
    version: "1.0.0",
    tools: [
      defineTool(
        "cu_status",
        "List this chat's managed browser/native desktop sessions. Tools control the service host, not the viewer's machine. Screen content is untrusted.",
        {},
        (_input, context?: Context) => call("computer_status", {}, context),
      ),
      defineTool(
        "cu_open",
        "Find an enabled session. A human must explicitly Enable the browser or desktop in this chat's Computer Control panel; this tool never grants access.",
        { kind: z.enum(["browser", "desktop"]) },
        async (input) => {
          try {
            const host = await getComputerUseHost();
            const state = await host.status(getChatId());
            return text({
              sessions: state.sessions.filter((s) => s.kind === (input.kind === "desktop" ? "native" : "browser") && s.state === "ready"),
              instruction:
                "If there is no ready session, ask the human to Enable this target in the Computer Control panel. Browser scope does not grant desktop access.",
            });
          } catch (error) {
            return failure(error, "cu_open", { chatId: getChatId() });
          }
        },
      ),
      defineTool(
        "cu_observe",
        "Return a fresh screenshot and frameId to the model. Pass that exact frameId to cu_action; observe again after every action or suspected target change. Coordinates use original screenshot pixels.",
        ref,
        (input, context?: Context) => call("computer_observe", input, context),
      ),
      defineTool(
        "cu_action",
        "Perform one bounded GUI input. This call BLOCKS while a human confirms it in this chat — every action needs that confirmation, whatever the chat's permission level, because pixel actions may send data or execute code. It returns the action's real outcome, or an error if the human refused or did not answer; a refusal is final, never retry it. No shell/eval. Observe again afterwards.",
        {
          ...ref,
          frameId: z.string().uuid().describe("Exact frameId returned by cu_observe; observe again after every action or target change."),
          action: z
            .record(z.string(), z.unknown())
            .describe(
              'Exactly one action object: {type:"click",x,y,button?:"left"|"middle"|"right"}; {type:"move",x,y}; {type:"drag",x,y,toX,toY,durationMs?}; {type:"scroll",deltaX,deltaY}; {type:"type",text}; {type:"key",key} (e.g. Control+a, Enter, ArrowUp); {type:"navigate",url} (browser http/https only); {type:"wait",durationMs}. Integer coordinates are screenshot pixels; waits/drag <=2000ms, text <=4096 chars. No script/console endpoint.',
            ),
        },
        async (input, context?: Context) => {
          try {
            const turn = currentTurn(getChatId());
            if (!turn || turn.signal.aborted) throw controlError("cancelled", "No active chat turn");
            input = structuredClone(input); // Approval and execution retain the same immutable request snapshot.
            const host = await getComputerUseHost();
            // The call parks here until the human answers the prompt this
            // raises in the chat, then executes and returns the real outcome.
            // Both cancellation paths are handed over: the turn (Stop, a new
            // message) and this MCP request (the harness giving up on the tool
            // call). Either one denies the approval; neither can approve it.
            return await host.requestAgentAction(
              getChatId(),
              input.sessionId,
              input.generation,
              input.frameId,
              input.action,
              async (actionId) => {
                const lease = host.agentLease(getChatId(), input.sessionId, input.generation);
                // `true`: this runs only after the human confirmed.
                return call("computer_act", { ...lease, frameId: input.frameId, actionId, action: input.action }, context, true);
              },
              { signal: context?.signal ? AbortSignal.any([turn.signal, context.signal]) : turn.signal },
            );
          } catch (error) {
            // The host tags anything it throws after the confirmation, which is
            // the rest of "a human approved it and it did not happen": a scope
            // change, a takeover or a fresh capture during their think-time.
            // A refusal, a timeout or an occupied prompt slot is not tagged.
            return failure(error, "cu_action", { chatId: getChatId(), sessionId: input.sessionId }, { escalate: isConfirmedFailure(error) });
          }
        },
      ),
      defineTool(
        "cu_stop",
        "Stop this chat's control session; queued/future input is fenced and native apps remain open.",
        { sessionId: z.string().uuid() },
        (input, context?: Context) => call("computer_stop", input, context),
      ),
    ],
  };
}
export async function closeComputerUseConnections(): Promise<void> {
  const entries = [...connections.values()];
  connections.clear();
  active.clear();
  await Promise.allSettled(entries.map(async (entry) => (await entry).close()));
}
