/**
 * The agent-facing MCP surface is blind in the same way the HTTP route was: it
 * hands the model a small error object and returns. These pin that a driver
 * fault reaches the operator's log, that a stopped turn does not, and that the
 * one failure a human is waiting on carries its cause.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";

const logs = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ createLogger: () => logs, default: () => logs }));
vi.mock("./computer-use.js", async (original) => ({
  ...(await original<typeof import("./computer-use.js")>()),
  getComputerUseHost: vi.fn(),
}));

import { ComputerUseHost, getComputerUseHost, type RaiseHumanApproval } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { beginComputerUseTurn, buildComputerUseToolsSpec, closeComputerUseConnections } from "./computer-use-tools.js";

let host: ComputerUseHost | undefined;
beforeEach(() => {
  logs.error.mockClear();
  logs.warn.mockClear();
  logs.debug.mockClear();
  logs.info.mockClear();
});
afterEach(async () => {
  await closeComputerUseConnections();
  await host?.dispose();
  host = undefined;
});

const frame = { data: "AA==", mimeType: "image/png" as const, width: 100, height: 100, capturedAt: Date.now() };
/**
 * A stand-in for the human at the chat prompt. Under `ask` nothing waits for
 * them any more — `cu_action` returns `approval_pending` — so the test answers
 * for them afterwards, by calling `approve`/`deny`. There is no approving
 * default: a fixture that silently says yes is the shape
 * `computer-use.invariant.test.ts` exists to forbid.
 */
function human() {
  const answers: ((approved: boolean) => unknown)[] = [];
  const raise: RaiseHumanApproval = (_chatId, _request, onAnswer) => {
    answers.push(onAnswer);
    return { requestId: `prompt-${answers.length}`, isOpen: () => true, cancel: () => true };
  };
  return { raise, approve: () => answers.at(-1)!(true), deny: () => answers.at(-1)!(false), asked: () => answers.length };
}

/**
 * A real service and host over a stub driver: the MCP hop is what is under test.
 *
 * The chat is set to `ask` unless a case says otherwise, because that is the
 * level with a human to be blind to.
 */
function harness(observe: () => Promise<typeof frame>, person = human(), level: "ask" | "allow" = "ask", act: () => Promise<void> = async () => {}) {
  const driver: Driver = {
    kind: "browser",
    probe: async () => ({ kind: "browser", available: true, capabilities: ["screenshot"] }),
    open: async () => ({ act, close: async () => {}, releaseInput: async () => {}, observe }),
  };
  const service = new ComputerUseService({
    targets: [{ id: "managed-browser", enabled: true, driver }],
    authorize: (request) => host?.authorize(request) ?? "deny",
  });
  const notices: string[] = [];
  host = new ComputerUseHost(
    service,
    { browser: driver, desktop: { ...driver, kind: "native-desktop" } },
    () => ({ policy: readComputerUsePolicy({ browserControl: level, computerControl: level, webAccess: "allow" }), signature: "scope" }),
    person.raise,
    (_chatId, text) => notices.push(text),
  );
  vi.mocked(getComputerUseHost).mockResolvedValue(host);
  const spec = buildComputerUseToolsSpec(() => "chat");
  return {
    host: host!,
    person,
    notices,
    tool: (name: string) => spec.tools.find((item) => item.name === name)!,
    /** Enable a target as the human does — one click, plus the panel confirmation under `ask`. */
    enable: async () => {
      const request = await host!.open("chat", "browser");
      return (request.state === "pending_approval" ? await host!.approve("chat", request.id) : request) as { id: string; generation: number };
    },
  };
}

const textOf = (result: { content: { type: string }[] }) =>
  JSON.parse((result.content.find((item) => item.type === "text") as unknown as { text: string }).text);
/** The one call that reached the driver, or undefined. */
const infoLine = (needle: string) => logs.info.mock.calls.map((call) => String(call[0])).find((entry) => entry.includes(needle));
const errorLine = (operation: string) => logs.error.mock.calls.map((call) => String(call[0])).find((line) => line.includes(operation));

it("records a driver fault the model only sees as an error tool result", async () => {
  const { tool, enable } = harness(async () => {
    throw new Error("Target page, context or browser has been closed");
  });
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await enable();

  const result = await tool("cu_observe").handler({ sessionId: opened.id, generation: opened.generation });
  end();

  expect(result.isError).toBe(true);
  expect(logs.error).toHaveBeenCalledOnce();
  expect(String(logs.error.mock.calls[0][0])).toContain(`computer_observe chat=chat session=${opened.id} code=driver_error`);
});

it("does not log a refusal from an idle facade at error level", async () => {
  const result = await buildComputerUseToolsSpec(() => "idle")
    .tools.find((item) => item.name === "cu_observe")!
    .handler({ sessionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", generation: 1 });

  expect(result.isError).toBe(true);
  expect(logs.error).not.toHaveBeenCalled();
  expect(logs.warn).not.toHaveBeenCalled();
  expect(String(logs.debug.mock.calls.at(0)?.[0])).toContain("code=cancelled");
});

it("treats a turn stopped mid-call as cancelled, not as a fault", async () => {
  // The pre-check before the MCP hop is the easy case. This is the common one:
  // the abort lands while `client.callTool` is in flight, and comes back as a
  // numeric -32001 McpError that carries no string code at all.
  const { tool, enable } = harness(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return frame;
  });
  const controller = new AbortController();
  beginComputerUseTurn(() => "chat", controller.signal);
  const opened = await enable();

  const inflight = tool("cu_observe").handler({ sessionId: opened.id, generation: opened.generation });
  setTimeout(() => controller.abort(), 60);
  const result = await inflight;

  expect(result.isError).toBe(true);
  expect(logs.error).not.toHaveBeenCalled();
  expect(logs.warn).not.toHaveBeenCalled();
  expect(String(logs.debug.mock.calls.at(-1)?.[0])).toContain("code=cancelled");
  expect(String(logs.debug.mock.calls.at(-1)?.[0])).toContain("This operation was aborted");
});

it("gives an approved action that failed in the driver a cause, at a level the operator sees", async () => {
  // The human's click returned 200 from `/respond` before anything ran, and
  // the agent only hears about it in a notice: this line is the operator's.
  const { tool, enable, person, notices } = harness(
    async () => frame,
    undefined,
    "ask",
    async () => {
      throw new Error("Target page, context or browser has been closed");
    },
  );
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await enable();
  const ref = { sessionId: opened.id, generation: opened.generation };
  const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;

  const pending = textOf(await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2 } }));
  expect(pending).toMatchObject({ status: "approval_pending" });
  end(); // The turn that asked is over; the approval still runs.
  person.approve();
  await vi.waitFor(() => expect(notices).toHaveLength(1));

  expect(errorLine("cu_action")).toContain(`cu_action chat=chat session=${opened.id} code=driver_error`);
  expect(infoLine("human-approved action did NOT run")).toContain("code=driver_error");
});

it("records an approved action that ran, so the operator's log says what the human let happen", async () => {
  const { tool, enable, person, notices } = harness(async () => frame);
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await enable();
  const ref = { sessionId: opened.id, generation: opened.generation };
  const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;
  await tool("cu_action").handler({ ...ref, frameId, action: { type: "type", text: "hunter2-my-real-password" } });
  end();
  person.approve();
  await vi.waitFor(() => expect(notices).toHaveLength(1));

  // Redacted like every other action line: the shape, never the text.
  expect(infoLine("human-approved action performed")).toContain("Type 24 characters into the managed browser");
  expect(logs.info.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("hunter2");
});

it("does not escalate an approval the world moved past: the agent is told to observe and re-request", async () => {
  // With no limit on the human's think-time, a fresh capture, a takeover or
  // a scope change before they answer is an expected outcome, not a fault —
  // `stale_frame` at error level is the noise the level table prevents. The
  // info line still records that a confirmed action did not run.
  const { tool, enable, person, notices } = harness(async () => frame);
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await enable();
  const ref = { sessionId: opened.id, generation: opened.generation };
  const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;

  const { controlPrincipal } = await import("./computer-use.js");
  await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2 } });
  // The agent's own cu_observe is refused while this waits, so move the frame
  // from underneath, as a target change would: a capture straight through the
  // service, between the watchdog's sweeps.
  await host!.service.observe(controlPrincipal("chat", "agent"), ref);
  end();
  person.approve(); // …and only now do they click Confirm
  await vi.waitFor(() => expect(notices).toHaveLength(1));

  expect(logs.error).not.toHaveBeenCalled();
  expect(infoLine("human-approved action did NOT run")).toContain("code=stale_frame");
  expect(notices[0]).toContain("cu_observe");
});

it("logs a refusal at warn — a prompt-injection signal, not a fault", async () => {
  const { tool, enable, person } = harness(async () => frame);
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await enable();
  const ref = { sessionId: opened.id, generation: opened.generation };
  const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;

  await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2 } });
  end();
  person.deny();

  expect(logs.error).not.toHaveBeenCalled();
  expect(String(logs.warn.mock.calls.at(-1)?.[0])).toContain("code=denied");
});

it("a pending request is not a failure, and a malformed one is refused before anyone is asked", async () => {
  const { tool, enable, person } = harness(async () => frame);
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await enable();
  const ref = { sessionId: opened.id, generation: opened.generation };
  const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;

  // `cu_action`'s outer schema is a loose record; under Ask the host applies
  // the strict grammar itself, so this extra key never reaches a human.
  const malformed = await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2, bogus: 9 } });
  expect(textOf(malformed)).toMatchObject({ error: "invalid_request" });
  expect(person.asked()).toBe(0);
  expect((await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2 } })).isError).toBeUndefined();
  end();

  expect(logs.error).not.toHaveBeenCalled();
  expect(logs.warn).not.toHaveBeenCalled();
  expect(String(logs.debug.mock.calls.at(-1)?.[0])).toContain("code=invalid_request");
});

/**
 * The `allow` half of the same blindness problem. Under `ask` the operator's
 * record of an action is the chat itself — the confirmation is a
 * `permission_request` the human answered — plus the host's own line when an
 * approved action runs or does not.
 * `allow` removes the prompt, so nothing outside the model's own transcript —
 * the one artifact a prompt-injected page can influence — would say what an
 * unattended agent did to a real browser. An `info` line per action closes it.
 */

it("records each unprompted action an allow chat attempts, so an operator can reconstruct the session", async () => {
  const { tool, enable, person } = harness(async () => frame, undefined, "allow");
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await enable();
  const ref = { sessionId: opened.id, generation: opened.generation };
  const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;

  expect((await tool("cu_action").handler({ ...ref, frameId, action: { type: "navigate", url: "https://example.com/dashboard" } })).isError).toBeUndefined();
  end();

  const line = infoLine("attempting unattended")!;
  expect(line).toBeDefined();
  expect(line).toContain(`chat=chat session=${opened.id}`);
  // The browser target's axis is Browser Use.
  expect(line).toContain("browserControl=allow");
  expect(line).toMatch(/Open https:\/\/example\.com\/dashboard in the managed browser on \S+$/);
  // It completed, so nothing corrects it. That absence is the success signal.
  expect(infoLine("did NOT complete")).toBeUndefined();
  // And nobody was asked: `allow` does not ask.
  expect(person.asked()).toBe(0);
});

/**
 * The line is written before the driver is reached — a process that dies
 * mid-action must still leave the trace — so it says "attempting", and an
 * action that does not happen gets a correction at the same level. Without it
 * the log would assert an unattended agent did something it did not do, and
 * `allow` failures are deliberately not escalated, so the detailed line sits at
 * `debug` where the default level cannot see it.
 */
it("corrects the record when an allow chat's action does not complete", async () => {
  const { tool, enable } = harness(async () => frame, undefined, "allow");
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await enable();
  const ref = { sessionId: opened.id, generation: opened.generation };
  const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;

  // The loose outer schema again: this only fails the strict `computer_act`
  // schema, which is a routine `invalid_request` when no human was promised it
  // would happen. It reaches the model as an error result rather than a throw,
  // so nothing but this reconciliation would notice.
  expect((await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2, bogus: 9 } })).isError).toBe(true);
  end();

  expect(infoLine("attempting unattended")).toBeDefined();
  const correction = infoLine("did NOT complete")!;
  expect(correction).toBeDefined();
  expect(correction).toContain(`chat=chat session=${opened.id}`);
  expect(correction).toContain("code=invalid_request");
  // Still not escalated: nobody is waiting on it, so the cause stays routine.
  expect(logs.error).not.toHaveBeenCalled();
  expect(String(logs.debug.mock.calls.at(-1)?.[0])).toContain("code=invalid_request");
});

/**
 * The log is a different artifact from the prompt. `~/.callboard/logs/` is
 * plaintext, at the default level, kept indefinitely, and pasted into bug
 * reports; #427's rule for this file is "error text and identifiers only —
 * browser sessions handle credentials and page content, and none of that
 * belongs here". The two content-bearing action types are where that rule is
 * either kept or broken.
 */
it("keeps typed text and URL query strings out of the log", async () => {
  const { tool, enable } = harness(async () => frame, undefined, "allow");
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await enable();
  const ref = { sessionId: opened.id, generation: opened.generation };

  const act = async (action: Record<string, unknown>) => {
    const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;
    return tool("cu_action").handler({ ...ref, frameId, action });
  };
  await act({ type: "type", text: "hunter2-my-real-password" });
  await act({ type: "navigate", url: "https://example.com/reset?token=SECRET-MAGIC-LINK#fragment-secret" });
  end();

  const written = logs.info.mock.calls.map((call) => String(call[0])).join("\n");
  expect(written).not.toContain("hunter2-my-real-password");
  expect(written).not.toContain("SECRET-MAGIC-LINK");
  expect(written).not.toContain("fragment-secret");
  // What survives is the shape: enough to reconstruct what the agent did.
  expect(infoLine("Type 24 characters into the managed browser")).toBeDefined();
  expect(infoLine("Open https://example.com/reset (query omitted) in the managed browser")).toBeDefined();
});

/**
 * A stopped turn is not a fault, and on this path it does not arrive as one:
 * `call()` converts everything — an abort included — into an `isError` result
 * carrying `{"error":"unavailable"}`, so an error-shaped check would record a
 * turn the user stopped as an unexplained failure. The abort travels with the
 * signal instead, exactly as `call()`'s own `logContext()` does.
 */
it("records a stopped turn as cancelled, not as an unexplained failure", async () => {
  let acting!: () => void;
  const entered = new Promise<void>((resolve) => {
    acting = resolve;
  });
  const { tool, enable } = harness(
    async () => frame,
    undefined,
    "allow",
    async () => {
      acting();
      await new Promise((resolve) => setTimeout(resolve, 400));
    },
  );
  const controller = new AbortController();
  beginComputerUseTurn(() => "chat", controller.signal);
  const opened = await enable();
  const ref = { sessionId: opened.id, generation: opened.generation };
  const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;

  const inflight = tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2 } });
  await entered;
  controller.abort();
  expect((await inflight).isError).toBe(true);

  expect(infoLine("attempting unattended")).toBeDefined();
  expect(infoLine("did NOT complete")).toContain("code=cancelled");
  expect(logs.error).not.toHaveBeenCalled();
});

/**
 * The redaction runs before the action is validated, so it has to do the
 * validating. `cu_action`'s outer schema is a loose record and the host's
 * pre-checks only bound the size and the `type`; the strict grammar does not
 * run until the MCP hop, inside `execute` — by which time this line is on
 * disk. Every payload below is rejected there, and every one of them would
 * have been written first.
 */
it.each([
  ["an opaque-origin URL whose payload lives in its path", { type: "navigate", url: "data:text/plain,SECRET-EXFIL-TOKEN" }],
  ["a javascript: URL", { type: "navigate", url: "javascript:alert(SECRET)" }],
  ["a local file URL", { type: "navigate", url: "file:///home/user/.ssh/SECRET_rsa" }],
  ["text smuggled through a key press", { type: "key", key: "SECRET-typed-as-a-key" }],
])("writes nothing about %s, because it validates before it describes", async (_case, action) => {
  const { tool, enable } = harness(async () => frame, undefined, "allow");
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await enable();
  const ref = { sessionId: opened.id, generation: opened.generation };
  const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;

  expect((await tool("cu_action").handler({ ...ref, frameId, action })).isError).toBe(true);
  end();

  const written = [...logs.info.mock.calls, ...logs.warn.mock.calls, ...logs.error.mock.calls].map((call) => String(call[0])).join("\n");
  expect(written).not.toContain("SECRET");
  // The attempt is still recorded — an operator must see that something was
  // tried — it just names the class instead of quoting the payload.
  expect(infoLine("attempting unattended")).toMatch(/Perform an invalid (navigate|key) action/);
});
