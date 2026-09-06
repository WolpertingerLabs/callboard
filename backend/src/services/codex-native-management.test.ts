import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const scratch = mkdtempSync(join(tmpdir(), "cb-native-controls-"));
process.env.CALLBOARD_DATA_DIR = scratch;
const state = vi.hoisted(() => ({ send: vi.fn(), callback: vi.fn() }));
vi.mock("./codex-native-agents.js", () => ({
  assertNativeAgentControllable: (id: string) => {
    if (id === "native-child") throw new Error("Native child read-only; ask parent root");
  },
  assertNativeAgentStoppable: (id: string) => {
    if (id === "native-child") throw new Error("Native child read-only; ask parent root");
  },
  nativeAgentForChat: (id: string) => (id === "native-child" ? { parentThreadId: "root", logPath: "/stub" } : null),
  refreshNativeMetadata: (_path: string, _id: string, raw: string) => raw,
  nativeMetadata: (_path: string, _id: string, metadata: unknown) => metadata,
  withNativeCodexChats: (chats: unknown[]) => chats,
  readNativeLifecycle: () => "unknown",
  NATIVE_CONTROL_NOTE: "Ask parent root",
}));
vi.mock("./session-callbacks.js", async (original) => ({
  ...(await original<typeof import("./session-callbacks.js")>()),
  registerCompletionCallback: state.callback,
}));
const { sendMessage, stopSession, stopSessionAndWait } = await import("./claude.js");
const { buildCallboardToolsSpec, setCallboardMessageSender } = await import("./callboard-tools.js");
const { chatFileService } = await import("./chat-file-service.js");
const { streamRouter } = await import("../routes/stream.js");
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("native child management rejects before side effects", () => {
  it("guards the real low-level sender, stop and teardown paths", async () => {
    const update = vi.spyOn(chatFileService, "updateChatMetadata");
    await expect(sendMessage({ chatId: "native-child", prompt: "do not run" })).rejects.toThrow("read-only");
    expect(stopSession("native-child")).toBe(false);
    expect(await stopSessionAndWait("native-child")).toBe("unstoppable");
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });
  it("guards MCP continuation before callback registration or sending, and reports unknown status", async () => {
    setCallboardMessageSender(state.send);
    const spec = buildCallboardToolsSpec(() => "root");
    const result = await spec.tools.find((t) => t.name === "continue_chat")!.handler({ chatId: "native-child", prompt: "hi", onComplete: true });
    expect(JSON.stringify(result)).toContain("read-only");
    expect(state.callback).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
    const status = await spec.tools.find((t) => t.name === "get_session_status")!.handler({ chatId: "native-child" });
    expect(JSON.stringify(status)).toContain("unknown");
  });
  it.each(["/:id/message", "/:id/stop"])("guards HTTP %s before metadata changes or SSE", async (path) => {
    const update = vi.spyOn(chatFileService, "updateChatMetadata");
    const layer = (
      streamRouter as unknown as { stack: { route?: { path: string; stack: { handle: (req: Request, res: Response) => unknown }[] } }[] }
    ).stack.find((item) => item.route?.path === path)!;
    const json = vi.fn();
    const writeHead = vi.fn();
    const status = vi.fn().mockReturnThis();
    const res = { status, json, writeHead } as unknown as Response;
    await layer.route!.stack[0].handle(
      { params: { id: "native-child" }, body: { prompt: "hi", model: "new-model", effort: "high" } } as unknown as Request,
      res,
    );
    expect(status).toHaveBeenCalledWith(409);
    expect(update).not.toHaveBeenCalled();
    expect(writeHead).not.toHaveBeenCalled();
    update.mockRestore();
  });
});
