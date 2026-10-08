/**
 * How `sendMessage` files chats into spaces, and what a space puts into the
 * session: the tree's space wins over a requested one, job steps follow their
 * run's root (else the job's `defaults.spaceId`), an independent spawn's
 * explicit space is honoured, folder rules decide otherwise, a discovered
 * session is stamped with its folder-rule space when first opened, recent
 * folders are recorded on the space the chat actually LANDED in, and space
 * instructions reach regular chats but not agent sessions.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentEvent } from "../agents/ports/events.js";
import type { StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-spaces-send-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-spaces-send-work-"));
const ruledDir = mkdtempSync(join(tmpdir(), "callboard-spaces-send-ruled-"));

vi.mock("./quick-completion.js", () => ({
  generateChatTitle: async () => null,
  generateBranchName: async () => null,
  quickCompletion: async () => ({ text: "" }),
}));
/** A discovered CLI session with no chat record, for the first-open stamp. */
const discovered = vi.hoisted(() => new Map<string, any>());
vi.mock("../utils/chat-lookup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/chat-lookup.js")>();
  return { ...actual, findChat: (id: string, ...rest: any[]) => discovered.get(id) ?? (actual.findChat as any)(id, ...rest) };
});

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { MockAgentProvider } = await import("../agents/adapters/mock/MockAgentProvider.js");
const { chatFileService } = await import("./chat-file-service.js");
const { createSpace, getSpace, updateSpace } = await import("./space-store.js");

const work = createSpace({ name: "Work", instructions: "Cite ticket numbers like ACME-1." });
const home = createSpace({ name: "Home", folderRules: [ruledDir] });

let counter = 0;
let provider: InstanceType<typeof MockAgentProvider>;

async function run(opts: Record<string, unknown>): Promise<string> {
  const sessionId = `space-sess-${++counter}`;
  const events: AgentEvent[] = [
    { type: "session_started", sessionId },
    { type: "text", content: "ok" },
    { type: "result", status: "success" },
  ];
  provider = new MockAgentProvider({ events });
  setAgentProviderForTesting(provider);
  const emitter = await sendMessage({ prompt: "go", ...opts } as never);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 10s")), 10_000);
    emitter.on("event", (e: StreamEvent) => {
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return sessionId;
}
const stampOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata).spaceId;
const appendOf = () => (provider.queryRecords[0].request as any).options?.systemPrompt?.append ?? "";

afterEach(() => setAgentProviderForTesting(null));
afterAll(() => {
  for (const dir of [dataDir, workDir, ruledDir]) rmSync(dir, { recursive: true, force: true });
});

describe("sendMessage — space assignment", () => {
  it("files a new top-level chat into the requested space and records the folder there", async () => {
    const id = await run({ folder: workDir, spaceId: work.id, recordRecentFolder: workDir });
    expect(stampOf(id)).toBe(work.id);
    expect(getSpace(work.id)!.defaults?.recentDirectories?.[0].path).toBe(workDir);
  });

  it("an independent spawn's explicit space is honoured (no tree to inherit from)", async () => {
    const id = await run({ folder: workDir, spaceId: home.id });
    expect(stampOf(id)).toBe(home.id);
  });

  it("a child joins its parent's tree's space, whatever was requested, and records the folder THERE", async () => {
    const root = chatFileService.createChat(workDir, "space-root-1", JSON.stringify({ spaceId: work.id }));
    const before = getSpace(home.id)!.defaults?.recentDirectories?.length ?? 0;
    const id = await run({ folder: workDir, parentChatId: root.id, spaceId: home.id, recordRecentFolder: "/elsewhere/picked" });
    expect(stampOf(id)).toBe(work.id);
    expect(getSpace(home.id)!.defaults?.recentDirectories?.length ?? 0).toBe(before);
    expect(getSpace(work.id)!.defaults?.recentDirectories?.[0].path).toBe("/elsewhere/picked");
  });

  it("a job step follows its run's root; with no root, the job's defaults.spaceId", async () => {
    const root = chatFileService.createChat(workDir, "space-root-2", JSON.stringify({ spaceId: home.id }));
    const stepInTree = await run({ folder: workDir, triggered: true, jobContext: { runId: "r1", stepId: "s1", rootChatId: root.id }, spaceId: work.id });
    expect(stampOf(stepInTree)).toBe(home.id);
    const loose = await run({ folder: workDir, triggered: true, jobContext: { runId: "r2", stepId: "s1" }, spaceId: work.id });
    expect(stampOf(loose)).toBe(work.id);
  });

  it("falls back to folder rules, and writes nothing for the default", async () => {
    expect(stampOf(await run({ folder: ruledDir }))).toBe(home.id);
    expect(stampOf(await run({ folder: workDir }))).toBeUndefined();
  });

  it("ignores an archived requested space, and never records recent folders on one", async () => {
    const old = createSpace({ name: "Old" });
    updateSpace(old.id, { archived: true });
    const id = await run({ folder: workDir, spaceId: old.id, recordRecentFolder: workDir });
    expect(stampOf(id)).toBeUndefined();
    const root = chatFileService.createChat(workDir, "space-root-3", JSON.stringify({ spaceId: old.id }));
    await run({ folder: workDir, parentChatId: root.id, recordRecentFolder: workDir });
    expect(getSpace(old.id)!.defaults?.recentDirectories).toBeUndefined();
  });

  it("stamps a discovered session with its folder-rule space the first time it is opened", async () => {
    discovered.set("disc-1", {
      id: "disc-1",
      folder: ruledDir,
      session_id: "disc-1",
      session_log_path: null,
      metadata: "{}",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      _from_filesystem: true,
    });
    await run({ chatId: "disc-1" });
    expect(stampOf("disc-1")).toBe(home.id);
  });
});

describe("sendMessage — space instructions", () => {
  it("appends the space's instructions to a regular chat's system prompt", async () => {
    await run({ folder: workDir, spaceId: work.id });
    expect(appendOf()).toContain("Cite ticket numbers like ACME-1.");
    expect(appendOf()).toContain('"Work" space');
  });

  it("leaves them out of an agent session, whose prompt is its persona's", async () => {
    await run({ folder: workDir, spaceId: work.id, agentAlias: "nobody" });
    expect(appendOf()).not.toContain("ACME-1");
  });

  it("adds nothing for a space without instructions", async () => {
    await run({ folder: workDir, spaceId: home.id });
    expect(appendOf()).not.toContain("# Space:");
  });
});
