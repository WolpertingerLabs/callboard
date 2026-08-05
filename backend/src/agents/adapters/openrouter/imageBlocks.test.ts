/**
 * Contract test: the `input_image` block we hand the harness has to survive
 * `@openrouter/sdk`'s own request validation, and has to still carry the image
 * once zod is done with it.
 *
 * This asserts against the real schema `responsesSend` runs (the harness calls
 * `betaResponsesSend`, an alias of it), because both failure modes are
 * invisible to a shape-equality test: a rejected block kills the request with
 * `Input validation failed`, and a block spelled `image_url` passes validation
 * while zod strips the URL and sends the model an image block with no image.
 */
import { describe, it, expect } from "vitest";
import * as operations from "@openrouter/sdk/models/operations";
import { orImageBlock, blockImageUrl } from "./imageBlocks.js";

/** Run one content block through the send-path schema, as `responsesSend` does. */
function encodeForRequest(block: unknown): Record<string, unknown> {
  const parsed = operations.CreateResponsesRequest$outboundSchema.parse({
    responsesRequest: { model: "openai/gpt-4o", input: [{ role: "user", content: [block] }] },
  }) as { ResponsesRequest: { input: { content: Record<string, unknown>[] }[] } };
  return parsed.ResponsesRequest.input[0]!.content[0]!;
}

describe("orImageBlock", () => {
  it("passes SDK request validation and reaches the wire with the image intact", () => {
    const dataUri = "data:image/png;base64,AAAA";
    expect(encodeForRequest(orImageBlock(dataUri))).toEqual({
      type: "input_image",
      image_url: dataUri,
      detail: "auto",
    });
  });

  it("passes for remote URLs too", () => {
    expect(encodeForRequest(orImageBlock("https://example.com/x.png"))).toMatchObject({
      image_url: "https://example.com/x.png",
    });
  });

  it("documents why the old snake_case shape can't come back", () => {
    // Rejected outright — this is what shipped against SDK 0.13.x.
    expect(() => encodeForRequest({ type: "input_image", image_url: "data:image/png;base64,AAAA" })).toThrow();
    // And the "obvious" fix of adding `detail` validates but drops the image.
    expect(encodeForRequest({ type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" })).not.toHaveProperty("image_url");
  });
});

describe("blockImageUrl", () => {
  it("reads both the current camelCase key and the legacy snake_case one", () => {
    expect(blockImageUrl({ imageUrl: "a" })).toBe("a");
    expect(blockImageUrl({ image_url: "b" })).toBe("b");
    expect(blockImageUrl({})).toBeNull();
  });
});
