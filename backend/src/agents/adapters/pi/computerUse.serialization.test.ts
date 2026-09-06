import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildPiTools } from "./toolAdapter.js";
import { defineTool } from "../../ports/tools.js";

it("pi 0.85.1 provider serializer retains custom-tool images, not just UI details", async () => {
  // Resolve the actual pi-ai version used by the pinned coding-agent, not an
  // unrelated hoisted version. No provider/model requests leave this test.
  const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const path = piRequire.resolve
    .paths("@earendil-works/pi-ai")!
    .map((root) => join(root, "@earendil-works/pi-ai/dist/api/anthropic-messages.js"))
    .find(existsSync)!;
  const { stream } = await import(pathToFileURL(path).href);
  const pixels = "aGk=";
  const { tools } = buildPiTools({
    name: "computer_use",
    version: "1",
    tools: [defineTool("cu_observe", "fixture", {}, async () => ({ content: [{ type: "image", data: pixels, mimeType: "image/webp" }] }))],
  });
  const result = await tools[0].execute("fixture-1", {}, undefined, undefined, undefined as never);
  let payload: unknown;
  const events = stream(
    {
      id: "offline-model",
      name: "offline",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://offline.invalid",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 10000,
      maxTokens: 100,
    },
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "fixture-1", name: "cu_observe", arguments: {} }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "offline-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 0,
        },
        { role: "toolResult", toolCallId: "fixture-1", toolName: "cu_observe", content: result.content, isError: false, timestamp: 1 },
      ],
    },
    {
      apiKey: "offline-fixture",
      onPayload: (body: unknown) => {
        payload = body;
        throw new Error("offline: stopped at provider serialization boundary");
      },
    },
  );
  await events.result();
  expect(payload).toMatchObject({
    messages: expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "tool_result",
            tool_use_id: "fixture-1",
            content: expect.arrayContaining([{ type: "image", source: { type: "base64", data: pixels, media_type: "image/webp" } }]),
          }),
        ]),
      }),
    ]),
  });
});
