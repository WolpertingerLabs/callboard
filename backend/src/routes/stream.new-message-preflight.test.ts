/**
 * `POST /api/chats/new/message` preflight order.
 *
 * Reasoning-effort validation probes the Codex CLI *in the requested cwd*. Run
 * ahead of the folder-exists check, a typo'd path came back as "effort not
 * supported for codex/unknown" instead of "folder does not exist". The cheap,
 * decisive check goes first; the probe never sees a folder that is not there.
 *
 * Same no-supertest style as stream.retired-provider.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { Request, Response } from "express";

const validateEffort = vi.hoisted(() => vi.fn(async (_input: unknown) => {}));
vi.mock("../services/reasoning-capabilities.js", () => ({ assertReasoningEffort: validateEffort }));
vi.mock("../services/claude.js", () => ({
  sendMessage: async () => new EventEmitter(),
  getActiveSession: () => null,
  stopSession: () => false,
  respondToPermission: () => false,
  hasPendingRequest: () => false,
  getPendingRequest: () => null,
  RetiredProviderError: class extends Error {},
}));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { notifyMetadata: () => {} } }));
vi.mock("../services/chat-file-service.js", () => ({ chatFileService: { getChat: () => null, updateChatMetadata: () => true } }));

const { streamRouter } = await import("./stream.js");

const newMessageHandler = (streamRouter as any).stack.find((layer: any) => layer.route?.path === "/new/message" && layer.route.methods.post).route.stack[0]
  .handle as (req: Request, res: Response) => Promise<void>;

async function post(body: Record<string, unknown>): Promise<{ status: number | null; json: { error?: string } | null }> {
  const state = { status: null as number | null, json: null as { error?: string } | null };
  const res = {
    status(code: number) {
      state.status = code;
      return this;
    },
    json(payload: unknown) {
      state.json = payload as { error?: string };
      return this;
    },
  } as unknown as Response;
  await newMessageHandler({ headers: {}, params: {}, body: { prompt: "hi", ...body }, on: () => {} } as unknown as Request, res);
  return state;
}

beforeEach(() => {
  validateEffort.mockReset();
});

describe("POST /new/message preflight order", () => {
  it("reports a missing folder before probing reasoning capabilities in it", async () => {
    validateEffort.mockImplementation(async () => {
      throw new Error('Reasoning effort "high" is not supported for codex/unknown');
    });
    const response = await post({ folder: "/definitely/not/a/folder", provider: "codex", effort: "high" });
    expect(response.status).toBe(400);
    expect(response.json?.error).toBe("folder does not exist");
    expect(validateEffort).not.toHaveBeenCalled();
  });
});
