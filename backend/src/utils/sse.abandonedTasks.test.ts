/**
 * SSE forwarding of `abandonedBackgroundTaskIds`.
 *
 * The field is the client's only chance to tell a background task that was
 * *killed* by the run ending from one that finished — both simply stop
 * spinning. The default branch of the forwarder collapses anything it does not
 * recognise into a bare `message_update`, so a field that is not named
 * explicitly here is silently dropped and the UI goes back to drawing the
 * failure as a success, with nothing failing to say so.
 *
 * Covered on both terminal frames, because they are not alternatives: an error
 * ends the run *instead of* a `done`, and it is one of the two endings most
 * likely to have left shells running.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "events";
import type { Response } from "express";
import type { StreamEvent } from "shared/types/index.js";
import { createSSEHandler } from "./sse.js";

/** Captures the `data:` frames a handler writes, parsed back out of the wire format. */
function fakeResponse() {
  const frames: Record<string, unknown>[] = [];
  const res = {
    write(chunk: string) {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) frames.push(JSON.parse(line.slice(6)));
      return true;
    },
    end() {},
  } as unknown as Response;
  return { res, frames };
}

function forward(event: StreamEvent): Record<string, unknown>[] {
  const { res, frames } = fakeResponse();
  const emitter = new EventEmitter();
  const handler = createSSEHandler(res, emitter);
  emitter.on("event", handler);
  emitter.emit("event", event);
  return frames;
}

describe("createSSEHandler — abandoned background tasks", () => {
  it("forwards the ids on a completed run", () => {
    const [frame] = forward({ type: "done", content: "", abandonedBackgroundTaskIds: ["bc0j6hx72"] } as StreamEvent);
    expect(frame.type).toBe("message_complete");
    expect(frame.abandonedBackgroundTaskIds).toEqual(["bc0j6hx72"]);
  });

  it("forwards the ids on a provider error, which ends the run without a `done`", () => {
    const [frame] = forward({ type: "error", content: "provider fell over", abandonedBackgroundTaskIds: ["a", "b"] } as StreamEvent);
    expect(frame.type).toBe("message_error");
    expect(frame.abandonedBackgroundTaskIds).toEqual(["a", "b"]);
  });

  it("omits the key entirely when nothing was left running", () => {
    // Not an empty array: every ordinary session ends this way, and a client
    // reading truthiness would see a casualty list on all of them.
    for (const event of [{ type: "done", content: "" }, { type: "error", content: "boom" }] as StreamEvent[]) {
      const [frame] = forward(event);
      expect(frame).not.toHaveProperty("abandonedBackgroundTaskIds");
    }
  });
});
