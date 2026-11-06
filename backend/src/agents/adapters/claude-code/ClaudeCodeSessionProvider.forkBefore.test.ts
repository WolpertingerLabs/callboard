/**
 * ClaudeCodeSessionProvider.forkSessionBefore — the positional "strictly
 * before this prompt" fork behind rerun, over a fixture shaped like a real CLI
 * log: the `attachment` lines the CLI writes AFTER a prompt are stamped 1 ms
 * BEFORE it, and its queue bookkeeping sits just before it. Same harness as the
 * compress suite.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeSessionProvider } from "./ClaudeCodeSessionProvider.js";
import { parseMessages } from "./sessionParser.js";

vi.mock("../../../agents/factory.js", () => ({ getSessionProviders: () => [] }));
const h = vi.hoisted(() => ({ projectsDir: "" }));
vi.mock("../../../utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/paths.js")>();
  return {
    ...actual,
    get CLAUDE_PROJECTS_DIR() {
      return h.projectsDir;
    },
    listClaudeProjectDirs: () => ["proj"],
  };
});

let TMP: string;
let PROJ_DIR: string;
const provider = new ClaudeCodeSessionProvider();

beforeEach(() => {
  TMP = join(tmpdir(), `cc-forkbefore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  PROJ_DIR = join(TMP, "proj");
  mkdirSync(PROJ_DIR, { recursive: true });
  h.projectsDir = TMP;
});
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

/* eslint-disable @typescript-eslint/no-explicit-any */
function writeSession(sessionId: string, lines: any[]) {
  writeFileSync(join(PROJ_DIR, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
function read(logPath: string): any[] {
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
const at = (s: number, ms: number) => new Date(Date.UTC(2026, 10, 6, 13, 51, s, ms)).toISOString();
const env = { sessionId: "orig", cwd: "/repo", version: "2.1.305", isSidechain: false, userType: "external" };

/** One turn as the CLI writes it: queue ops, the prompt, its attachments stamped 1 ms earlier, the reply. */
function turn(n: number, s: number, prompt: string, reply: string, parent: string | null): any[] {
  const u = `u${n}`;
  return [
    { type: "queue-operation", operation: "enqueue", timestamp: at(s, 20), sessionId: "orig", content: prompt },
    { type: "queue-operation", operation: "dequeue", timestamp: at(s, 30), sessionId: "orig" },
    { ...env, type: "user", parentUuid: parent, uuid: u, timestamp: at(s, 49), message: { role: "user", content: prompt } },
    { ...env, type: "attachment", parentUuid: u, uuid: `${u}-att1`, timestamp: at(s, 48), attachment: { type: "environment" } },
    { ...env, type: "attachment", parentUuid: `${u}-att1`, uuid: `${u}-att2`, timestamp: at(s, 48), attachment: { type: "model" } },
    {
      ...env,
      type: "assistant",
      parentUuid: `${u}-att2`,
      uuid: `a${n}`,
      timestamp: at(s + 2, 0),
      message: { role: "assistant", id: `msg_${n}`, content: [{ type: "text", text: reply }] },
    },
  ];
}
const fixture = () => [...turn(1, 10, "say the word DOG", "DOG", null), ...turn(2, 25, "now say CAT", "CAT", "a1")];
const userTexts = (lines: any[]) =>
  parseMessages(lines)
    .filter((m) => m.role === "user")
    .map((m) => m.content);
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("forkSessionBefore", () => {
  it("cuts at the prompt's line, though the attachment after it is stamped earlier", () => {
    writeSession("orig", fixture());
    const forked = provider.forkSessionBefore(["orig"], at(25, 49), "new-id");
    expect(forked).not.toBeNull();
    const lines = read(forked!.logPath);
    expect(userTexts(lines)).toEqual(["say the word DOG"]);
    expect(lines.at(-1)).toMatchObject({ uuid: "a1", sessionId: "new-id" });
    // The second turn's queue bookkeeping goes with its prompt.
    expect(lines.filter((l) => l.type === "queue-operation")).toHaveLength(2);
  });

  it("is the trap it replaces: a timestamp cutoff one ms before the prompt keeps it", () => {
    writeSession("orig", fixture());
    const lines = read(provider.forkSession(["orig"], at(25, 48), "ts-cut")!.logPath);
    expect(userTexts(lines)).toEqual(["say the word DOG", "now say CAT"]);
  });

  it("returns null for the opening prompt and for a timestamp that names no prompt", () => {
    writeSession("orig", fixture());
    expect(provider.forkSessionBefore(["orig"], at(10, 49), "new-id")).toBeNull();
    // An attachment's stamp is not a prompt.
    expect(provider.forkSessionBefore(["orig"], at(25, 48), "new-id")).toBeNull();
    expect(provider.forkSessionBefore(["orig"], "garbage", "new-id")).toBeNull();
  });

  it("closes a tool_use left open before the prompt with an interrupted result", () => {
    const lines = fixture();
    lines[5] = { ...lines[5], message: { role: "assistant", id: "msg_1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } };
    writeSession("orig", lines);
    const forked = read(provider.forkSessionBefore(["orig"], at(25, 49), "new-id")!.logPath);
    expect(forked.at(-1)).toMatchObject({ type: "user", parentUuid: "a1", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] } });
  });
});

describe("continue-from (forkSession at a message) on the same log", () => {
  it("does not pick up the next prompt through its early-stamped attachments", () => {
    writeSession("orig", fixture());
    // At the DOG reply: the CAT turn's lines are all stamped after it.
    const lines = read(provider.forkSession(["orig"], at(12, 0), "cont")!.logPath);
    expect(userTexts(lines)).toEqual(["say the word DOG"]);
    expect(lines.at(-1)).toMatchObject({ uuid: "a1" });
    // At the CAT prompt itself: it is kept with its attachments, as continue-from means.
    const atPrompt = read(provider.forkSession(["orig"], at(25, 49), "cont2")!.logPath);
    expect(atPrompt.slice(-2).map((l) => l.type)).toEqual(["attachment", "attachment"]);
  });
});
