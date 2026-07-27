/**
 * `beginSSE` — the server side of the capability handshake
 * (`plans/wire-capability-negotiation.md`, Phase 1).
 *
 * The claim under test is that Phase 1 is inert for a client that never heard
 * of it: a request with no handshake headers gets the same headers and the same
 * event frames as before, with exactly one new leading frame it is structurally
 * guaranteed to ignore (it dispatches on `type`, and has no branch for
 * `server_info`).
 *
 * Driven with a fake Express response rather than a live server, matching the
 * no-supertest style used by the route tests.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "events";
import type { Request, Response } from "express";
import type { IncomingHttpHeaders } from "http";
import { CLIENT_CAPS, handshakeHeaders } from "shared/types/index.js";
import type { StreamEvent } from "../services/claude.js";
import { beginSSE, createSSEHandler } from "./sse.js";

/**
 * The event types the frontend's SSE reader knew about before this change
 * (`frontend/src/pages/Chat.tsx` — `readSSE`). Anything outside this set falls
 * through its dispatch chain and is dropped, which is the compatibility
 * mechanism `server_info` relies on.
 */
const LEGACY_KNOWN_TYPES = new Set([
  "chat_created",
  "message_complete",
  "message_error",
  "compacting",
  "cleared",
  "budget",
  "message_update",
  "permission_request",
  "user_question",
  "plan_review",
]);

interface FakeRes {
  res: Response;
  head: { status: number; headers: Record<string, string> } | null;
  chunks: string[];
  ended: boolean;
}

function fakeResponse(): FakeRes {
  const state: FakeRes = {
    head: null,
    chunks: [],
    ended: false,
    res: null as unknown as Response,
  };
  state.res = {
    writeHead(status: number, headers: Record<string, string>) {
      state.head = { status, headers };
      return this;
    },
    write(chunk: string) {
      state.chunks.push(chunk);
      return true;
    },
    end() {
      state.ended = true;
      return this;
    },
  } as unknown as Response;
  return state;
}

function fakeRequest(headers: IncomingHttpHeaders = {}): Request {
  return { headers } as unknown as Request;
}

/** Lowercase the handshake headers the way Node delivers them. */
function handshakeAsReceived(): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(handshakeHeaders()).map(([k, v]) => [k.toLowerCase(), v]));
}

/**
 * Parse a written SSE stream the way the frontend does: keep only `data: `
 * lines, JSON.parse each. Deliberately ignores `event:` name lines — that is
 * the existing reader's behavior, and this asserts the new frame doesn't
 * corrupt it.
 */
function parseAsFrontend(chunks: string[]): Record<string, unknown>[] {
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

/** A representative run: some updates, a permission prompt, a budget beacon, then done. */
const CANONICAL_RUN: StreamEvent[] = [
  { type: "text", content: "hello" },
  { type: "tool_use", content: "", toolName: "Read", toolSource: "local" },
  { type: "permission_request", content: "", toolName: "Bash" } as StreamEvent,
  { type: "budget", content: "", costUsd: 0.25, maxBudgetUsd: 5 },
  { type: "compacting", content: "" },
  { type: "done", content: "", reason: "max_turns", costUsd: 0.5, maxBudgetUsd: 5, objectiveComplete: true },
];

/**
 * The exact bytes {@link CANONICAL_RUN} must produce, hand-written.
 *
 * Deliberately *not* derived from `createSSEHandler`: comparing the handshake
 * path against a second run of the same current code proves only that
 * `beginSSE` prepends one frame, and stays green through any change that
 * regresses both paths together. (Proven: dropping `costUsd` from the `budget`
 * branch of `sse.ts` left every test in this file passing.) These literals are
 * the regression net — a payload that changes shape must be changed here too,
 * which puts the wire change in the diff where a reviewer sees it.
 *
 * Key order is pinned along with content because this file's claim is
 * byte-identity for a client that never reloads. Reordering keys is a
 * deliberate wire edit, not an incidental one.
 */
const EXPECTED_RUN_CHUNKS: string[] = [
  `data: {"type":"message_update"}\n\n`,
  `data: {"type":"message_update"}\n\n`,
  `data: {"type":"permission_request","content":"","toolName":"Bash"}\n\n`,
  `data: {"type":"budget","costUsd":0.25,"maxBudgetUsd":5}\n\n`,
  `data: {"type":"compacting"}\n\n`,
  `data: {"type":"message_complete","reason":"max_turns","costUsd":0.5,"maxBudgetUsd":5,"objectiveComplete":true}\n\n`,
];

function replayCanonicalRun(res: Response): void {
  const emitter = new EventEmitter();
  const onEvent = createSSEHandler(res, emitter);
  emitter.on("event", onEvent);

  for (const event of CANONICAL_RUN) emitter.emit("event", event);
}

describe("beginSSE", () => {
  it("writes the same SSE headers as before", () => {
    const f = fakeResponse();

    beginSSE(fakeRequest(), f.res);

    expect(f.head).toEqual({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  });

  it("sends server_info as the very first frame", () => {
    const f = fakeResponse();

    beginSSE(fakeRequest(), f.res);

    expect(f.chunks.length).toBe(1);
    expect(f.chunks[0].startsWith("event: server_info\ndata: ")).toBe(true);
    expect(f.chunks[0].endsWith("\n\n")).toBe(true);

    const [frame] = parseAsFrontend(f.chunks);
    expect(frame.type).toBe("server_info");
    expect(frame.protocolVersion).toBe(2);
    expect(frame.minProtocolVersion).toBe(1);
    expect(Array.isArray(frame.features)).toBe(true);
    expect(typeof frame.serverVersion).toBe("string");
  });

  it("returns the client's advertised capabilities", () => {
    const f = fakeResponse();

    const session = beginSSE(fakeRequest(handshakeAsReceived()), f.res);

    expect(session.protocolVersion).toBe(2);
    expect(session.supports(CLIENT_CAPS.toolSource)).toBe(true);
    expect(session.supports(CLIENT_CAPS.budgetEvents)).toBe(true);
    expect(session.supports(CLIENT_CAPS.planReview)).toBe(true);
  });

  it("returns an empty-capability session for a client that sends no handshake", () => {
    const f = fakeResponse();

    const session = beginSSE(fakeRequest(), f.res);

    expect(session.protocolVersion).toBe(1);
    expect(session.capabilities).toEqual([]);
    expect(session.supports(CLIENT_CAPS.toolSource)).toBe(false);
  });

  it("sends the identical server_info frame to handshaking and legacy clients", () => {
    const legacy = fakeResponse();
    const modern = fakeResponse();

    beginSSE(fakeRequest(), legacy.res);
    beginSSE(fakeRequest(handshakeAsReceived()), modern.res);

    expect(legacy.chunks).toEqual(modern.chunks);
  });
});

describe("legacy client (no handshake) is unaffected", () => {
  it("writes the exact frame bytes a pre-handshake client already parsed", () => {
    const f = fakeResponse();

    beginSSE(fakeRequest(), f.res);
    replayCanonicalRun(f.res);

    // Pinned against hand-written literals, not against another run of the
    // code under test — see EXPECTED_RUN_CHUNKS.
    expect(f.chunks.slice(1)).toEqual(EXPECTED_RUN_CHUNKS);
  });

  it("writes those same frames with no handshake frame at all when beginSSE is not used", () => {
    // The pre-change server: createSSEHandler alone, no leading frame. Pins the
    // claim that beginSSE is the *only* source of the extra frame.
    const f = fakeResponse();

    replayCanonicalRun(f.res);

    expect(f.chunks).toEqual(EXPECTED_RUN_CHUNKS);
  });

  it("receives byte-identical event frames — server_info is the only addition", () => {
    const legacy = fakeResponse();
    const baseline = fakeResponse();

    // Legacy client: handshake path, no headers sent.
    beginSSE(fakeRequest(), legacy.res);
    replayCanonicalRun(legacy.res);

    // Baseline: what the server wrote before this change — no leading frame.
    replayCanonicalRun(baseline.res);

    // Proves beginSSE prepends exactly one frame and touches nothing else.
    // Frame *content* is pinned by the two tests above; this one is about
    // position and count.
    expect(legacy.chunks.slice(1)).toEqual(baseline.chunks);
    expect(legacy.chunks[0]).toContain("server_info");
    expect(legacy.ended).toBe(baseline.ended);
  });

  it("still sees every frame it knows, and nothing it doesn't know but server_info", () => {
    const f = fakeResponse();

    beginSSE(fakeRequest(), f.res);
    replayCanonicalRun(f.res);

    const types = parseAsFrontend(f.chunks).map((frame) => frame.type);

    expect(types).toEqual(["server_info", "message_update", "message_update", "permission_request", "budget", "compacting", "message_complete"]);
    // Everything after the new frame is a type the old bundle already handles;
    // server_info itself is not, so it falls through and is ignored.
    expect(types.filter((t) => !LEGACY_KNOWN_TYPES.has(t as string))).toEqual(["server_info"]);
  });

  it("does not derail a `data: `-prefix parser with the event-name line", () => {
    const f = fakeResponse();

    beginSSE(fakeRequest(), f.res);
    replayCanonicalRun(f.res);

    // Every data line parses; the `event: server_info` line is skipped as a
    // non-`data:` line, exactly as the frontend reader skips heartbeats.
    expect(() => parseAsFrontend(f.chunks)).not.toThrow();
    expect(parseAsFrontend(f.chunks).length).toBe(7);
  });

  it("preserves the payloads the old bundle reads off message_complete", () => {
    const f = fakeResponse();

    beginSSE(fakeRequest(), f.res);
    replayCanonicalRun(f.res);

    const complete = parseAsFrontend(f.chunks).find((frame) => frame.type === "message_complete");
    expect(complete).toEqual({ type: "message_complete", reason: "max_turns", costUsd: 0.5, maxBudgetUsd: 5, objectiveComplete: true });
  });
});
