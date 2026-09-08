/**
 * Who may change the fifth permission axis.
 *
 * `PATCH /api/chats/:id/permissions` sits under this router's `requireAuth`,
 * which accepts a Bearer `cbk_` key. That is correct for the four original
 * axes — widening a chat's own file/exec/web permissions over the API is a
 * supported workflow. It is not correct for `computerControl`, because of what
 * `allow` now means: the agent performs GUI actions with nobody asked.
 *
 * The attack is not immediate, which is why it is easy to wave away. An agent
 * flipping its own chat to `allow` revokes any live grant, since the level is
 * in the authorization signature — it cannot enable a target, at any level. But
 * the human's NEXT Enable click, made for an ordinary reason and believing they
 * are enabling the `ask` behaviour they configured, would then hand over
 * unattended control. Before the level governed prompting, the flip bought an
 * agent almost nothing; it now buys the whole thing.
 *
 * So the axis keeps the guarantees of the control plane it governs
 * (`requireSessionAuth` + `requireControlOrigin` on `/api/computer-use/*`):
 * a logged-in, same-origin human. The other four axes stay answerable by a key,
 * and so does a request that leaves this one alone.
 *
 * Same no-supertest style as chats.regenerate-title.test.ts: the handler is
 * pulled off the router stack and driven with a fake req/res.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import type { DefaultPermissions } from "shared/types/index.js";

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-perm-auth-"));

let chat: any;
const upsertChat = vi.fn((id: string, folder: string, sessionId: string, updates: Record<string, unknown>) => ({
  id,
  folder,
  session_id: sessionId,
  ...updates,
}));

vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  findChat: () => chat,
}));
vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: { upsertChat: (...args: any[]) => (upsertChat as any)(...args), getChat: () => chat },
}));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, pendingRequestFingerprint: () => "" }));

const { chatsRouter } = await import("./chats.js");

const handler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/permissions" && layer.route.methods.patch).route.stack[0]
  .handle as (req: Request, res: Response) => void;

const FOUR = { fileRead: "allow", fileWrite: "ask", codeExecution: "ask", webAccess: "ask" } as const;

/** One request, with the actor and origin the middleware would have established. */
function patch(
  defaultPermissions: Record<string, unknown>,
  actor: { authMethod?: "session" | "bearer"; origin?: string | null; host?: string; secFetchSite?: string } = { authMethod: "session" },
): Promise<{ code: number; body: any }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (actor.origin !== null) headers.origin = actor.origin ?? "https://callboard.local";
    headers.host = actor.host ?? "callboard.local";
    if (actor.secFetchSite) headers["sec-fetch-site"] = actor.secFetchSite;
    const req = {
      params: { id: "chat-1" },
      body: { defaultPermissions },
      get: (name: string) => headers[name.toLowerCase()],
    } as unknown as Request;
    const res = {
      statusCode: 200,
      locals: { authMethod: actor.authMethod },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    handler(req, res as unknown as Response);
  });
}

/** The permissions blob the route wrote, or undefined if it wrote nothing. */
const written = (): DefaultPermissions | undefined => {
  const call = upsertChat.mock.calls.at(-1);
  return call && JSON.parse((call[3] as any).metadata).defaultPermissions;
};

function setStored(computerControl?: string) {
  chat = {
    id: "chat-1",
    folder: "/repo",
    session_id: "session-1",
    metadata: JSON.stringify({ defaultPermissions: { ...FOUR, ...(computerControl ? { computerControl } : {}) } }),
  };
}

beforeEach(() => {
  upsertChat.mockClear();
  setStored("ask");
});

describe("PATCH /api/chats/:id/permissions — the computerControl axis", () => {
  it("refuses a bearer key that raises the level, and writes nothing", async () => {
    const result = await patch({ ...FOUR, computerControl: "allow" }, { authMethod: "bearer" });

    expect(result.code).toBe(403);
    expect(result.body).toMatchObject({ code: "denied", error: expect.stringContaining("logged-in session") });
    expect(upsertChat).not.toHaveBeenCalled();
  });

  it("refuses a bearer key that lowers it too: an agent does not get to set the level that governs it", async () => {
    setStored("allow");
    const result = await patch({ ...FOUR, computerControl: "deny" }, { authMethod: "bearer" });

    expect(result.code).toBe(403);
    expect(upsertChat).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin session, the same rule the computer-control plane applies", async () => {
    for (const actor of [
      { authMethod: "session" as const, origin: "https://evil.example" },
      { authMethod: "session" as const, origin: null },
      { authMethod: "session" as const, secFetchSite: "cross-site" },
    ]) {
      upsertChat.mockClear();
      const result = await patch({ ...FOUR, computerControl: "allow" }, actor);
      expect(result.code, JSON.stringify(actor)).toBe(403);
      expect(upsertChat).not.toHaveBeenCalled();
    }
  });

  it("lets a same-origin logged-in human set it, which is the whole point", async () => {
    const result = await patch({ ...FOUR, computerControl: "allow" });

    expect(result.code).toBe(200);
    expect(written()).toMatchObject({ computerControl: "allow" });
  });

  it("leaves the other four axes answerable by an API key", async () => {
    const result = await patch({ ...FOUR, fileWrite: "allow", computerControl: "ask" }, { authMethod: "bearer" });

    expect(result.code).toBe(200);
    expect(written()).toMatchObject({ fileWrite: "allow", computerControl: "ask" });
  });

  it("preserves the stored level when the request omits the axis, rather than clearing it behind the human's back", async () => {
    // A four-axis client — a legacy tab, or an API caller written before the
    // axis existed. `normalizePermissions` reads an absent value as `deny`, so
    // a full-replacement write would have silently dropped a level the human
    // set. Preserving is both safer and the only reading of "did not ask".
    setStored("allow");
    const result = await patch({ ...FOUR }, { authMethod: "bearer" });

    expect(result.code).toBe(200);
    expect(written()).toMatchObject({ computerControl: "allow" });
  });

  it("treats an absent stored axis as deny, so a key cannot grant it by writing deny→ask", async () => {
    setStored(undefined);
    expect((await patch({ ...FOUR, computerControl: "ask" }, { authMethod: "bearer" })).code).toBe(403);
    // …and writing the level it already effectively has is not a change.
    expect((await patch({ ...FOUR, computerControl: "deny" }, { authMethod: "bearer" })).code).toBe(200);
    expect(written()).toMatchObject({ computerControl: "deny" });
  });

  it("still validates the axis before anything else", async () => {
    const result = await patch({ ...FOUR, computerControl: "sometimes" }, { authMethod: "bearer" });
    expect(result.code).toBe(400);
    expect(upsertChat).not.toHaveBeenCalled();
  });
});
