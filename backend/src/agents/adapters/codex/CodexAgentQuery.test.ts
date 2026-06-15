/**
 * Lifecycle tests for {@link CodexAgentQuery} focused on the tool-bridge slice:
 * the query owns the tool-server handles built for its run and must close them
 * (stop sockets, remove temp dirs) once the run ends by ANY path — normal
 * completion (iterate's finally) or an early/abort `close()`. These guard against
 * leaking listening sockets per Codex turn.
 *
 * The Codex SDK itself is stubbed so the tests never spawn the real `codex exec`
 * CLI; only the close-handle plumbing is exercised (per `lesson-sdk-callback-mocks`
 * we drive the event stream the SDK would emit rather than invoking internal
 * callbacks).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Codex } from "@openai/codex-sdk";
import { CodexAgentQuery, resolveCodexInput } from "./CodexAgentQuery.js";
import type { CodexToolServerHandle } from "./toolAdapter.js";

/** A handle whose close() flips a flag and counts calls, so a test can assert it
 *  was closed exactly once. */
function countingHandle(name: string): CodexToolServerHandle & { closeCount: number } {
  const handle = {
    name,
    version: "1.0.0",
    socketPath: `/tmp/${name}.sock`,
    closeCount: 0,
    toMcpServerConfig: () => ({ command: "node", args: ["/shim.js", `/tmp/${name}.sock`] }),
    close: async () => {
      handle.closeCount += 1;
    },
  };
  return handle;
}

/** A Codex stub whose thread emits no events and completes immediately. */
function stubCodex(): Codex {
  const thread = {
    runStreamed: async () => ({
      events: (async function* () {
        /* no events — turn completes immediately */
      })(),
    }),
  };
  return { startThread: () => thread, resumeThread: () => thread } as unknown as Codex;
}

const MODELS = [{ value: "gpt-5.5", displayName: "GPT-5.5", description: "" }];

describe("CodexAgentQuery — tool-server lifecycle", () => {
  it("closes tool servers after a normal run completes", async () => {
    const h1 = countingHandle("a");
    const h2 = countingHandle("b");
    const query = new CodexAgentQuery({
      codex: stubCodex(),
      resumeId: null,
      threadOptions: {},
      prompt: "hi",
      toolServerHandles: [h1, h2],
      models: MODELS,
    });

    // Drain the (empty) event stream — iterate()'s finally runs the cleanup.
    for await (const _ of query) {
      void _;
    }

    expect(h1.closeCount).toBe(1);
    expect(h2.closeCount).toBe(1);
  });

  it("closes tool servers on close() even before iteration", async () => {
    const h1 = countingHandle("a");
    const query = new CodexAgentQuery({
      codex: stubCodex(),
      resumeId: null,
      threadOptions: {},
      prompt: "hi",
      toolServerHandles: [h1],
      models: MODELS,
    });

    await query.close();
    expect(h1.closeCount).toBe(1);
  });

  it("does not double-close when close() follows a completed run", async () => {
    const h1 = countingHandle("a");
    const query = new CodexAgentQuery({
      codex: stubCodex(),
      resumeId: null,
      threadOptions: {},
      prompt: "hi",
      toolServerHandles: [h1],
      models: MODELS,
    });

    for await (const _ of query) {
      void _;
    }
    await query.close();
    expect(h1.closeCount).toBe(1);
  });

  it("no handles → close() is a harmless no-op", async () => {
    const query = new CodexAgentQuery({
      codex: stubCodex(),
      resumeId: null,
      threadOptions: {},
      prompt: "hi",
      models: MODELS,
    });
    await expect(query.close()).resolves.toBeUndefined();
  });
});

describe("resolveCodexInput — multimodal prompts", () => {
  it("materializes base64 image blocks as Codex local_image inputs", async () => {
    const tempDirs: string[] = [];
    const pngBytes = Buffer.from("hello-image");

    const prompt = (async function* () {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "who is this" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: pngBytes.toString("base64"),
              },
            },
          ],
        },
      };
    })();

    try {
      const input = await resolveCodexInput(prompt, { tempDirs });

      expect(Array.isArray(input)).toBe(true);
      if (!Array.isArray(input)) throw new Error("expected Codex input array");
      const items = input;
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ type: "text", text: "who is this" });
      expect(items[1].type).toBe("local_image");
      if (items[1].type !== "local_image") throw new Error("expected local_image");
      expect(items[1].path.endsWith(".png")).toBe(true);
      expect(existsSync(items[1].path)).toBe(true);
      expect(readFileSync(items[1].path)).toEqual(pngBytes);
      expect(tempDirs).toHaveLength(1);
    } finally {
      for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes durable path image blocks through without creating temp files", async () => {
    const tempDirs: string[] = [];
    const imagePath = "/tmp/callboard-codex-image-existing.png";

    const prompt = (async function* () {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", source: { type: "path", media_type: "image/png", path: imagePath } },
          ],
        },
      };
    })();

    // The adapter only passes through existing paths.
    writeFileSync(imagePath, Buffer.from("fake-image"));
    try {
      const input = await resolveCodexInput(prompt, { tempDirs });
      if (!Array.isArray(input)) throw new Error("expected Codex input array");
      expect(input[1]).toEqual({ type: "local_image", path: imagePath });
      expect(tempDirs).toEqual([]);
    } finally {
      rmSync(imagePath, { force: true });
    }
  });
});
