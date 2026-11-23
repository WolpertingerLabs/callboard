/**
 * Who may change the two control axes (`browserControl` — Browser Use, and
 * `computerControl` — Computer Use).
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
/** The route's writer: a quiet read-merge-write over the stored record. */
const updateChatMetadata = vi.fn((_id: string, _fields: Record<string, unknown>, _opts?: { touch?: boolean }) => true);

vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  findChat: () => chat,
}));
vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: { updateChatMetadata: (...args: any[]) => (updateChatMetadata as any)(...args), getChat: () => chat },
}));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false }));

const { chatsRouter } = await import("./chats.js");

const handler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/permissions" && layer.route.methods.patch).route.stack[0]
  .handle as (req: Request, res: Response) => void;

const FOUR = { fileRead: "allow", fileWrite: "ask", codeExecution: "ask", webAccess: "ask" } as const;

/** One request, with the actor and origin the middleware would have established. */
function patch(
  defaultPermissions: Record<string, unknown>,
  actor: { authMethod?: "session" | "bearer"; origin?: string | null; host?: string; secFetchSite?: string } = { authMethod: "session" },
  extra: Record<string, unknown> = {},
): Promise<{ code: number; body: any }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (actor.origin !== null) headers.origin = actor.origin ?? "https://callboard.local";
    headers.host = actor.host ?? "callboard.local";
    if (actor.secFetchSite) headers["sec-fetch-site"] = actor.secFetchSite;
    const req = {
      params: { id: "chat-1" },
      body: { defaultPermissions, ...extra },
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
  const call = updateChatMetadata.mock.calls.at(-1);
  return call && (call[1] as any).defaultPermissions;
};

/** Stores both control axes at `computerControl`'s level unless `browserControl` is given separately. */
function setStored(computerControl?: string, browserControl: string | undefined = computerControl) {
  chat = {
    id: "chat-1",
    folder: "/repo",
    session_id: "session-1",
    metadata: JSON.stringify({
      defaultPermissions: { ...FOUR, ...(browserControl ? { browserControl } : {}), ...(computerControl ? { computerControl } : {}) },
    }),
  };
}

beforeEach(() => {
  updateChatMetadata.mockClear();
  setStored("ask");
});

describe("PATCH /api/chats/:id/permissions — the control axes", () => {
  it("refuses a bearer key that raises the level, and writes nothing", async () => {
    const result = await patch({ ...FOUR, browserControl: "allow", computerControl: "allow" }, { authMethod: "bearer" });

    expect(result.code).toBe(403);
    expect(result.body).toMatchObject({ code: "denied", error: expect.stringContaining("logged-in session") });
    expect(updateChatMetadata).not.toHaveBeenCalled();
  });

  it("refuses a bearer key that lowers it too: an agent does not get to set the level that governs it", async () => {
    setStored("allow");
    const result = await patch({ ...FOUR, browserControl: "deny", computerControl: "deny" }, { authMethod: "bearer" });

    expect(result.code).toBe(403);
    expect(updateChatMetadata).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin session, the same rule the computer-control plane applies", async () => {
    for (const actor of [
      { authMethod: "session" as const, origin: "https://evil.example" },
      { authMethod: "session" as const, origin: null },
      { authMethod: "session" as const, secFetchSite: "cross-site" },
    ]) {
      updateChatMetadata.mockClear();
      const result = await patch({ ...FOUR, browserControl: "allow", computerControl: "allow" }, actor);
      expect(result.code, JSON.stringify(actor)).toBe(403);
      expect(updateChatMetadata).not.toHaveBeenCalled();
    }
  });

  it("lets a same-origin logged-in human set it, which is the whole point", async () => {
    const result = await patch({ ...FOUR, browserControl: "allow", computerControl: "allow" });

    expect(result.code).toBe(200);
    expect(written()).toMatchObject({ browserControl: "allow", computerControl: "allow" });
  });

  it("leaves the other four axes answerable by an API key", async () => {
    const result = await patch({ ...FOUR, fileWrite: "allow", browserControl: "ask", computerControl: "ask" }, { authMethod: "bearer" });

    expect(result.code).toBe(200);
    expect(written()).toMatchObject({ fileWrite: "allow", browserControl: "ask", computerControl: "ask" });
  });

  it("preserves the stored level when the request omits the axis, rather than clearing it behind the human's back", async () => {
    // A four-axis client — a legacy tab, or an API caller written before the
    // axis existed. `normalizePermissions` reads an absent value as `deny`, so
    // a full-replacement write would have silently dropped a level the human
    // set. Preserving is both safer and the only reading of "did not ask".
    setStored("allow");
    const result = await patch({ ...FOUR }, { authMethod: "bearer" });

    expect(result.code).toBe(200);
    expect(written()).toMatchObject({ browserControl: "allow", computerControl: "allow" });
  });

  it("treats an absent stored axis as deny, so a key cannot grant it by writing deny→ask", async () => {
    setStored(undefined);
    expect((await patch({ ...FOUR, browserControl: "ask", computerControl: "ask" }, { authMethod: "bearer" })).code).toBe(403);
    // …and writing the level it already effectively has is not a change.
    expect((await patch({ ...FOUR, browserControl: "deny", computerControl: "deny" }, { authMethod: "bearer" })).code).toBe(200);
    expect(written()).toMatchObject({ browserControl: "deny", computerControl: "deny" });
  });

  it("refuses a bearer key that changes only Browser Use, naming that axis", async () => {
    const result = await patch({ ...FOUR, browserControl: "allow", computerControl: "ask" }, { authMethod: "bearer" });

    expect(result.code).toBe(403);
    expect(result.body.error).toContain("Browser Use");
    expect(updateChatMetadata).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin session that changes only Browser Use", async () => {
    const result = await patch({ ...FOUR, browserControl: "allow", computerControl: "ask" }, { authMethod: "session", origin: "https://evil.example" });
    expect(result.code).toBe(403);
    expect(updateChatMetadata).not.toHaveBeenCalled();
  });

  it("keeps a stored Browser Use level when an older tab sends only the original five axes", async () => {
    // A bundle that predates `browserControl` sends fileRead…computerControl.
    // Normalizing would read the missing key as deny and silently switch
    // Browser Use off; it must be kept, exactly like an omitted computerControl.
    setStored("ask", "allow");
    for (const actor of [{ authMethod: "session" as const }, { authMethod: "bearer" as const }]) {
      const result = await patch({ ...FOUR, computerControl: "ask" }, actor);
      expect(result.code, actor.authMethod).toBe(200);
      expect(written()).toMatchObject({ browserControl: "allow", computerControl: "ask" });
    }
  });

  describe("an older tab changing computerControl without sending browserControl", () => {
    // Such a body can only come from a bundle where that row was "Browser &
    // Computer Control". Its Deny meant "no GUI control"; its Ask/Allow meant
    // the browser, which computerControl no longer governs.
    it("Deny also denies Browser Use, so the old row's Deny is honoured", async () => {
      setStored("allow", "allow");
      const result = await patch({ ...FOUR, computerControl: "deny" });
      expect(result.code).toBe(200);
      expect(written()).toMatchObject({ browserControl: "deny", computerControl: "deny" });
    });

    it.each(["ask", "allow"] as const)("%s is refused with 409 and applies nothing, rather than granting desktop-only Computer Use", async (requested) => {
      setStored("deny", "deny");
      const result = await patch({ ...FOUR, fileWrite: "allow", computerControl: requested });
      expect(result.code).toBe(409);
      expect(result.body).toMatchObject({ code: "stale_client", error: expect.stringMatching(/Reload the tab/) });
      expect(updateChatMetadata).not.toHaveBeenCalled();
    });

    it("still needs a same-origin session before anything else: an API key gets 403, not 409", async () => {
      setStored("deny", "deny");
      expect((await patch({ ...FOUR, computerControl: "allow" }, { authMethod: "bearer" })).code).toBe(403);
      setStored("allow", "allow");
      expect((await patch({ ...FOUR, computerControl: "deny" }, { authMethod: "bearer" })).code).toBe(403);
      expect(updateChatMetadata).not.toHaveBeenCalled();
    });

    it("an unchanged computerControl keeps the stored Browser Use level", async () => {
      setStored("deny", "allow");
      const result = await patch({ ...FOUR, computerControl: "deny" });
      expect(result.code).toBe(200);
      expect(written()).toMatchObject({ browserControl: "allow", computerControl: "deny" });
    });
  });

  it("lets a human change Browser Use independently of Computer Use", async () => {
    const result = await patch({ ...FOUR, browserControl: "allow", computerControl: "deny" });
    expect(result.code).toBe(200);
    expect(written()).toMatchObject({ browserControl: "allow", computerControl: "deny" });
  });

  it("validates browserControl too", async () => {
    const result = await patch({ ...FOUR, browserControl: "sometimes" }, { authMethod: "session" });
    expect(result.code).toBe(400);
    expect(result.body.error).toContain("browserControl");
  });

  it("writes quietly: configuration is not activity, so updated_at is left alone", async () => {
    await patch({ ...FOUR });
    expect(updateChatMetadata.mock.calls.at(-1)?.[2]).toEqual({ touch: false });
  });

  it("still validates the axis before anything else", async () => {
    const result = await patch({ ...FOUR, computerControl: "sometimes" }, { authMethod: "bearer" });
    expect(result.code).toBe(400);
    expect(updateChatMetadata).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/chats/:id/permissions — review-chain toggles", () => {
  const fields = () => updateChatMetadata.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;

  it("stores modelReview / parentAnswers when on, clears them when off", async () => {
    expect((await patch({ ...FOUR, browserControl: "ask", computerControl: "ask" }, { authMethod: "bearer" }, { modelReview: true, parentAnswers: true })).code).toBe(200);
    expect(fields()).toMatchObject({ modelReview: true, parentAnswers: true });
    expect((await patch({ ...FOUR, browserControl: "ask", computerControl: "ask" }, { authMethod: "session" }, { modelReview: false })).code).toBe(200);
    expect(fields()).toMatchObject({ modelReview: null });
  });

  it("leaves them alone when omitted", async () => {
    chat.metadata = JSON.stringify({ ...JSON.parse(chat.metadata), modelReview: true });
    await patch({ ...FOUR, browserControl: "ask", computerControl: "ask" });
    expect(fields()).toMatchObject({ modelReview: true });
  });

  it("rejects a non-boolean", async () => {
    const result = await patch({ ...FOUR, browserControl: "ask", computerControl: "ask" }, { authMethod: "session" }, { parentAnswers: "yes" });
    expect(result.code).toBe(400);
    expect(updateChatMetadata).not.toHaveBeenCalled();
  });
});
