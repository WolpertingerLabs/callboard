/**
 * The rollout tail — the only path by which a Codex compaction becomes visible.
 *
 * The public `--experimental-json` lane emits five event types and an
 * eight-member `ThreadItem` union, none of which mention compaction, so these
 * tests are what stand between the feature and a silent regression. They run
 * against `__fixtures__/rollout-cli-0.153.4-compacting.jsonl`, which is
 * byte-verbatim lines from the real failed run (chat `01a07b74`, 2026-09-07):
 * six genuine `ContextCompaction` records with their real ids, thirteen
 * `token_count` records carrying `model_context_window: 258400`, and
 * AgentMessage / CommandExecution / Reasoning / UserMessage lines as noise the
 * extractor must ignore.
 *
 * The replay tests write that file a byte-range at a time to reproduce what the
 * tail actually faces: reads landing mid-line while another process appends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../../services/agent-settings.js", () => ({ getAgentSettings: () => ({}) }));

import { RolloutTail, extractCompactions, findRolloutPath, type RolloutCompaction } from "./rolloutTail.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "rollout-cli-0.153.4-compacting.jsonl");
const THREAD_ID = "01a07b74-1a80-71a0-8d2c-0765d3711f09";

/** The six real compaction ids in the fixture, in file order. */
const REAL_COMPACTION_IDS = [
  "01a07b74-7ce2-78c3-8d78-f449cd0d5a5a",
  "01a07b75-6327-7dd3-80ef-5743c5a25595",
  "01a07b76-311c-79e0-8fe0-ed3fed85601d",
  "01a07b76-ec58-71b1-a35f-43a7c41dcb3c",
  "01a07b77-8be8-7191-ac45-b0b8a9d40632",
  "01a07b78-2c51-7b91-8b76-0a74a8821a39",
];

let home: string;
let dayDir: string;
let rolloutPath: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-tail-test-"));
  prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const now = new Date();
  dayDir = join(
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

/** Spin until `predicate` holds or the budget runs out. Keeps the poll real. */
async function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("extractCompactions", () => {
  it("pulls exactly the six real compactions out of the captured rollout", () => {
    const lines = readFileSync(FIXTURE, "utf-8").split("\n");
    const { compactions, contextWindow } = extractCompactions(lines);

    expect(compactions.map((c) => c.id)).toEqual(REAL_COMPACTION_IDS);
    // Carried forward from the preceding `token_count`, not from the
    // compaction record (which has only `{id, type}`).
    expect(contextWindow).toBe(258400);
    expect(compactions.every((c) => c.contextWindow === 258400)).toBe(true);
  });

  it("ignores every non-compaction item type in the same file", () => {
    const lines = readFileSync(FIXTURE, "utf-8").split("\n");
    // The fixture really does contain these — otherwise the test proves nothing.
    const present = lines.filter((l) => l.includes('"AgentMessage"') || l.includes('"UserMessage"') || l.includes('"Reasoning"'));
    expect(present.length).toBeGreaterThan(0);

    expect(extractCompactions(lines).compactions).toHaveLength(6);
  });

  it("skips malformed and empty lines instead of throwing", () => {
    const lines = ["", "   ", "{not json", "null", "[]", '{"payload":null}', '{"payload":{"type":"item_completed"}}'];
    expect(() => extractCompactions(lines)).not.toThrow();
    expect(extractCompactions(lines).compactions).toEqual([]);
  });

  it("accepts the snake_case spelling a future CLI might use", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { id: "x1", type: "context_compaction" } } });
    expect(extractCompactions([line]).compactions).toEqual([{ id: "x1" }]);
  });

  it("carries a context window forward but does not invent one", () => {
    const compaction = JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { id: "c1", type: "ContextCompaction" } } });
    expect(extractCompactions([compaction]).compactions).toEqual([{ id: "c1" }]);

    const tokenCount = JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { model_context_window: 1234 } } });
    expect(extractCompactions([tokenCount, compaction]).compactions).toEqual([{ id: "c1", contextWindow: 1234 }]);
  });
});

describe("findRolloutPath", () => {
  it("finds the rollout for a thread id in today's dated directory", () => {
    writeFileSync(rolloutPath, "");
    expect(findRolloutPath(THREAD_ID)).toBe(rolloutPath);
  });

  it("returns null when the file does not exist yet", () => {
    expect(findRolloutPath(THREAD_ID)).toBeNull();
  });

  it("does not match a different thread's rollout", () => {
    writeFileSync(rolloutPath, "");
    expect(findRolloutPath("01a07b74-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("RolloutTail", () => {
  it("emits exactly one event per compaction and never re-fires", async () => {
    const seen: RolloutCompaction[] = [];
    const tail = new RolloutTail(THREAD_ID, { onCompaction: (c) => seen.push(c) }, 10);
    // File does not exist yet at start — the real ordering, since the CLI
    // creates it just after `thread.started`.
    tail.start();

    await new Promise((r) => setTimeout(r, 40));
    expect(seen).toHaveLength(0);

    writeFileSync(rolloutPath, readFileSync(FIXTURE, "utf-8"));
    await waitFor(() => seen.length === 6);
    expect(seen.map((c) => c.id)).toEqual(REAL_COMPACTION_IDS);

    // Keep polling well past the last append: a re-fire would show up here.
    await new Promise((r) => setTimeout(r, 120));
    expect(seen).toHaveLength(6);
    tail.stop();
  });

  it("survives reads that land mid-line while the CLI is appending", async () => {
    const seen: RolloutCompaction[] = [];
    const tail = new RolloutTail(THREAD_ID, { onCompaction: (c) => seen.push(c) }, 5);
    writeFileSync(rolloutPath, "");
    tail.start();

    // Append in 64-byte slices so polls are guaranteed to observe partial
    // lines. A naive JSON.parse of the tail of the buffer would throw here.
    const content = readFileSync(FIXTURE, "utf-8");
    for (let i = 0; i < content.length; i += 64) {
      appendFileSync(rolloutPath, content.slice(i, i + 64));
      await new Promise((r) => setTimeout(r, 1));
    }

    await waitFor(() => seen.length === 6);
    expect(seen.map((c) => c.id)).toEqual(REAL_COMPACTION_IDS);
    tail.stop();
  });

  it("does not re-emit when the file is rewritten from the start", async () => {
    const seen: RolloutCompaction[] = [];
    const tail = new RolloutTail(THREAD_ID, { onCompaction: (c) => seen.push(c) }, 10);
    const content = readFileSync(FIXTURE, "utf-8");
    writeFileSync(rolloutPath, content);
    tail.start();

    await waitFor(() => seen.length === 6);

    // Truncate and replay the same bytes — a resumed session re-reading its own
    // rollout. Dedupe is on the record's own id, so nothing repeats.
    writeFileSync(rolloutPath, content);
    await new Promise((r) => setTimeout(r, 120));
    expect(seen).toHaveLength(6);
    tail.stop();
  });

  it("emits nothing after stop(), and stop() is safe twice and before start()", async () => {
    const seen: RolloutCompaction[] = [];
    const tail = new RolloutTail(THREAD_ID, { onCompaction: (c) => seen.push(c) }, 5);

    tail.stop(); // before start
    tail.start(); // must not resurrect a stopped tail
    writeFileSync(rolloutPath, readFileSync(FIXTURE, "utf-8"));
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(0);

    tail.stop();
    tail.stop(); // idempotent
  });

  it("stops emitting as soon as stop() is called mid-run", async () => {
    const seen: RolloutCompaction[] = [];
    const tail = new RolloutTail(THREAD_ID, { onCompaction: (c) => seen.push(c) }, 5);
    writeFileSync(rolloutPath, "");
    tail.start();
    tail.stop();

    writeFileSync(rolloutPath, readFileSync(FIXTURE, "utf-8"));
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(0);
  });

  it("does not throw when the rollout disappears underneath it", async () => {
    const seen: RolloutCompaction[] = [];
    const tail = new RolloutTail(THREAD_ID, { onCompaction: (c) => seen.push(c) }, 5);
    writeFileSync(rolloutPath, readFileSync(FIXTURE, "utf-8"));
    tail.start();
    await waitFor(() => seen.length === 6);

    rmSync(rolloutPath, { force: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toHaveLength(6);
    tail.stop();
  });

  it("swallows a throwing handler rather than failing the run", async () => {
    let calls = 0;
    const tail = new RolloutTail(
      THREAD_ID,
      {
        onCompaction: () => {
          calls++;
          throw new Error("consumer blew up");
        },
      },
      5,
    );
    writeFileSync(rolloutPath, readFileSync(FIXTURE, "utf-8"));
    tail.start();
    await waitFor(() => calls === 6);
    expect(calls).toBe(6);
    tail.stop();
  });
});
