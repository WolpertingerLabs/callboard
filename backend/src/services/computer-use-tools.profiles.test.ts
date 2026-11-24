/**
 * The agent's Sandbox desktop profile tools, as the model sees them: three
 * tools in the computer_use server — propose, status, cancel — and nothing
 * that approves, builds, promotes or removes. Each is refused for a chat the
 * daemon cannot authorize; the human-only card cannot be answered by an API
 * key or a parent chat.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SANDBOX_PROFILE_PROPOSE_TOOL_NAME } from "shared/types/index.js";
import { beginComputerUseTurn, buildComputerUseToolsSpec } from "./computer-use-tools.js";
import { clearOpenApprovalsForTest, getPendingRequest, openHumanApproval, pendingRequestRequiresHuman, respondToPermission } from "./pending-requests.js";

afterEach(() => clearOpenApprovalsForTest());

const spec = () =>
  buildComputerUseToolsSpec(
    () => "no-such-chat",
    () => ({ mode: "managed" }),
  );
const tool = (name: string) => spec().tools.find((item) => item.name === name)!;
const parse = (result: { content: { type: string; text?: string }[] }) => JSON.parse(result.content[0]!.text!) as Record<string, unknown>;

describe("sandbox profile tools", () => {
  it("are propose, status and cancel; no tool approves, builds, promotes or removes", () => {
    const names = spec().tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["sandbox_profile_propose", "sandbox_profile_status", "sandbox_profile_cancel"]));
    expect(names.filter((n) => /approve|promote|remove|build|delete/.test(n))).toEqual([]);
  });

  it("explain the propose → approve → build → test → iterate loop, and that build logs are untrusted", () => {
    for (const name of ["sandbox_profile_propose", "sandbox_profile_status"]) {
      const { description } = tool(name);
      expect(description).toContain("propose → approve → build → test → iterate");
      expect(description).toContain('cu_request_control {kind:"sandbox", profile:<name>}');
      expect(description).toMatch(/never approve, build, promote or remove/);
    }
    expect(tool("sandbox_profile_status").description).toMatch(/UNTRUSTED/);
    expect(tool("sandbox_profile_cancel").description).toMatch(/cannot be cancelled here/);
  });

  it("refuse a chat the daemon cannot authorize (unknown, archived, or without Sandbox desktop)", async () => {
    const stop = beginComputerUseTurn(() => "no-such-chat", new AbortController().signal);
    try {
      const proposed = await tool("sandbox_profile_propose").handler({ name: "eyes", recipe: { schema: 1, name: "eyes", description: "x" } });
      expect(proposed.isError).toBe(true);
      expect(parse(proposed)).toMatchObject({ error: "denied" });
      expect(parse(await tool("sandbox_profile_status").handler({}))).toMatchObject({ error: "denied" });
      expect(parse(await tool("sandbox_profile_cancel").handler({ buildId: "00000000-0000-0000-0000-000000000000" }))).toMatchObject({ error: "denied" });
    } finally {
      stop();
    }
  });

  it("propose needs a live turn", async () => {
    const result = await tool("sandbox_profile_propose").handler({ name: "eyes", recipe: {} });
    expect(parse(result)).toMatchObject({ error: "cancelled" });
  });
});

describe("the proposal card is human-only", () => {
  it("is answered only by a request naming it, and never by an API key or a parent chat", () => {
    const answers: boolean[] = [];
    const card = openHumanApproval("chat-h", { toolName: SANDBOX_PROFILE_PROPOSE_TOOL_NAME, controlRequest: true, input: { name: "eyes" } }, (approved) => {
      answers.push(approved);
    });
    // `/respond` refuses a non-session actor whenever this is true (routes/stream.ts).
    expect(pendingRequestRequiresHuman("chat-h", card.requestId)).toBe(true);
    expect(pendingRequestRequiresHuman("chat-h")).toBe(true);
    // A parent's respond_to_request only answers the blocking slot, which this is not.
    expect(getPendingRequest("chat-h")).toMatchObject({ humanOnly: true, requestId: card.requestId, eventData: { controlRequest: true, nonBlocking: true } });
    // An answer that does not name it (an old tab, a guess) reaches nothing.
    expect(respondToPermission("chat-h", true).ok).toBe(false);
    expect(respondToPermission("chat-h", true, undefined, undefined, "wrong").ok).toBe(false);
    expect(answers).toEqual([]);
    expect(respondToPermission("chat-h", true, undefined, undefined, card.requestId).ok).toBe(true);
    expect(answers).toEqual([true]);
  });
});
