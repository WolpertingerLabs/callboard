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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Codex } from "@openai/codex-sdk";
import { CodexAgentQuery, resolveCodexInput } from "./CodexAgentQuery.js";
import type { CodexToolServerHandle } from "./toolAdapter.js";
import { ROLLOUT_POLL_MS } from "./rolloutTail.js";

vi.mock("../../../services/agent-settings.js", () => ({ getAgentSettings: () => ({}) }));

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
      models: async () => MODELS,
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
      models: async () => MODELS,
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
      models: async () => MODELS,
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
      models: async () => MODELS,
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

/**
 * Compaction visibility end-to-end through the query.
 *
 * The Codex public lane never reports a compaction (verified against CLI
 * 0.153.4: five event types, an eight-member `ThreadItem` union, no compaction
 * in either), so `CodexAgentQuery` tails the run's rollout and merges
 * `compaction_boundary` into the event stream. These tests drive the real merge
 * — a stubbed SDK stream plus a real rollout file on disk — because the failure
 * being fixed is precisely a stream that goes quiet for minutes: a compaction
 * has to surface while the source iterator is parked, not merely get flushed
 * behind the next SDK event.
 *
 * The rollout fixture is byte-verbatim lines from the real failed run.
 */
describe("CodexAgentQuery — rollout compaction merge", () => {
  const THREAD_ID = "01a07b74-1a80-71a0-8d2c-0765d3711f09";
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "rollout-cli-0.153.4-compacting.jsonl");

  let home: string;
  let rolloutPath: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codex-query-tail-"));
    prevHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    const now = new Date();
    const dayDir = join(
      home,
      "sessions",
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );
    mkdirSync(dayDir, { recursive: true });
    rolloutPath = join(dayDir, `rollout-2026-09-07T06-40-01-${THREAD_ID}.jsonl`);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * A Codex stub that emits `thread.started` (so the tail learns the id), then
   * parks until `release()` — standing in for the real run's 235-second silence
   * — and only then completes.
   */
  function quietCodex(): { codex: Codex; release: () => void } {
    let release!: () => void;
    const parked = new Promise<void>((r) => (release = r));
    const thread = {
      runStreamed: async () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: THREAD_ID };
          await parked;
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
        })(),
      }),
    };
    return { codex: { startThread: () => thread, resumeThread: () => thread } as unknown as Codex, release };
  }

  it("surfaces compactions while the SDK stream is silent", async () => {
    const { codex, release } = quietCodex();
    const query = new CodexAgentQuery({ codex, resumeId: null, threadOptions: {}, prompt: "hi", models: async () => MODELS });

    const events: string[] = [];
    const drained = (async () => {
      for await (const event of query) events.push(event.type);
    })();

    // Wait for the tail to have resolved the (not yet existing) rollout, then
    // write the compacting run. The SDK stream is still parked throughout.
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(rolloutPath, readFileSync(FIXTURE, "utf-8"));

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && events.filter((e) => e === "compaction_boundary").length < 6) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Six compactions delivered BEFORE the source stream produced its next
    // event — that is the whole point of the merge.
    expect(events.filter((e) => e === "compaction_boundary")).toHaveLength(6);
    expect(events).not.toContain("result");

    release();
    await drained;
    expect(events.filter((e) => e === "compaction_boundary")).toHaveLength(6);
    expect(events).toContain("result");
  });

  it("tears the tail down on abort, leaving no interval behind", async () => {
    const { codex } = quietCodex();
    const query = new CodexAgentQuery({ codex, resumeId: null, threadOptions: {}, prompt: "hi", models: async () => MODELS });

    const events: string[] = [];
    const drained = (async () => {
      for await (const event of query) events.push(event.type);
    })();
    await new Promise((r) => setTimeout(r, 50));

    // Abort mid-run (the close() path), then make the rollout compaction-rich.
    // A leaked tail would keep polling and keep pushing events.
    await query.close();
    const before = events.length;
    writeFileSync(rolloutPath, readFileSync(FIXTURE, "utf-8"));
    await new Promise((r) => setTimeout(r, 200));

    expect(events.length).toBe(before);
    expect(events).not.toContain("compaction_boundary");
    void drained;
  });

  it("starts the tail from resumeId before any event arrives", async () => {
    // A resumed turn appends to a rollout that already exists, so compactions
    // must be observable without waiting for `thread.started`.
    writeFileSync(rolloutPath, readFileSync(FIXTURE, "utf-8"));
    // Outlast one real poll cycle (ROLLOUT_POLL_MS = 500ms). The interval is
    // tuned for runs that stall for minutes, so a turn shorter than one tick
    // legitimately reports nothing — there is nothing to show yet.
    // A stream that stays open for `ms` and then ends having emitted nothing —
    // written as an explicit iterator rather than a generator because a
    // generator with no `yield` is exactly what it sounds like.
    const openButSilent = (ms: number) => ({
      [Symbol.asyncIterator]() {
        let waited = false;
        return {
          async next() {
            if (!waited) {
              waited = true;
              await new Promise((r) => setTimeout(r, ms));
            }
            return { value: undefined as never, done: true as const };
          },
        };
      },
    });
    const thread = { runStreamed: async () => ({ events: openButSilent(ROLLOUT_POLL_MS * 2 + 200) }) };
    const codex = { startThread: () => thread, resumeThread: () => thread } as unknown as Codex;
    const query = new CodexAgentQuery({ codex, resumeId: THREAD_ID, threadOptions: {}, prompt: "hi", models: async () => MODELS });

    const events: string[] = [];
    for await (const event of query) events.push(event.type);

    expect(events.filter((e) => e === "compaction_boundary")).toHaveLength(6);
  });
});
