import { expect, it } from "vitest";
import { bindManagedClineTools } from "./managedToolBindings.js";
import { defineTool } from "../../ports/tools.js";

it("resident Cline wrappers rebind to current turn and fail closed when idle/removed/aborted", async () => {
  const spec = (label: string) => [{ name: "computer_use", version: "1", tools: [defineTool("cu_status", "fixture", {}, async (_args, context) => ({ content: [{ type: "text" as const, text: `${label}:${context?.toolCallId}` }] }))] }];
  const first = bindManagedClineTools("resident-fixture", spec("first"), new AbortController().signal);
  const resident = first.specs[0].tools[0];
  expect((await resident.handler({}, { toolCallId: "one" })).content).toEqual([{ type: "text", text: "first:one" }]);
  first.release();
  await expect(resident.handler({})).rejects.toThrow("no active turn");
  const abort = new AbortController();
  const second = bindManagedClineTools("resident-fixture", spec("second"), abort.signal);
  try {
    first.release(); // Old cleanup cannot unbind a replacement turn.
    expect((await resident.handler({}, { toolCallId: "two" })).content).toEqual([{ type: "text", text: "second:two" }]);
    abort.abort();
    await expect(resident.handler({})).rejects.toThrow();
  } finally { second.release(); }
  const removed = bindManagedClineTools("resident-fixture", [], new AbortController().signal);
  try { await expect(resident.handler({})).rejects.toThrow("no active turn"); }
  finally { removed.release(); }
});
