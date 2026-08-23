/**
 * The daemon's half of stale-bundle detection: say which build you are, on a
 * request that already happens, and only when the answer is news.
 *
 * `GET /api/sessions/poll` is deliberately tiny — the comment on the route
 * calls it "~40 bytes of JSON when nothing has changed" — and it runs once a
 * second per open tab. So the interesting assertions here are as much about
 * what the response *does not* contain as what it does: a build id echoed back
 * in `b` buys silence, and the steady state has to stay the steady state.
 *
 * The reading side (`readBuildIdFrom`) is tested against real files rather than
 * a mocked `fs`, because every failure it handles is a filesystem fact — no
 * file, truncated JSON, a key of the wrong type — and a mock would only assert
 * that the author imagined them correctly.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import { UNKNOWN_BUILD_ID } from "shared";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-build-id-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("../services/session-registry.js", () => ({
  sessionRegistry: { version: 7, metadataVersion: 3, getAll: () => ({}), activeSummons: new Map() },
}));

// The route reads through this; stubbing the service keeps the test off
// whatever `frontend/dist` happens to hold on the machine running it.
let serverBuildId = "1.0.0-alpha.49+gaaaaaaaaaaaa";
vi.mock("../services/build-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/build-identity.js")>();
  return { ...actual, getServerBuildId: () => serverBuildId };
});

const { sessionsRouter } = await import("./sessions.js");
const { readBuildIdFrom } = await import("../services/build-identity.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const pollHandler = (sessionsRouter as any).stack.find((layer: any) => layer.route?.path === "/poll" && layer.route.methods.get).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function poll(query: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve) => {
    const res = {
      json(payload: any) {
        resolve(payload);
        return this;
      },
    };
    pollHandler({ query } as unknown as Request, res as unknown as Response);
  });
}

beforeEach(() => {
  serverBuildId = "1.0.0-alpha.49+gaaaaaaaaaaaa";
});

describe("GET /api/sessions/poll — build id", () => {
  it("reports the build id to a client that has not seen one", async () => {
    const body = await poll({ v: "7", mv: "3" });
    expect(body.build).toBe("1.0.0-alpha.49+gaaaaaaaaaaaa");
  });

  it("stays silent when the client echoes the id it already has", async () => {
    const body = await poll({ v: "7", mv: "3", b: "1.0.0-alpha.49+gaaaaaaaaaaaa" });
    expect(body).not.toHaveProperty("build");
    // The whole point of the echo: nothing changed anywhere, so the response is
    // the two counters and nothing else.
    expect(Object.keys(body).sort()).toEqual(["metadataVersion", "version"]);
  });

  it("reports the new id once the daemon has moved", async () => {
    serverBuildId = "1.0.0-alpha.50+gbbbbbbbbbbbb";
    const body = await poll({ v: "7", mv: "3", b: "1.0.0-alpha.49+gaaaaaaaaaaaa" });
    expect(body.build).toBe("1.0.0-alpha.50+gbbbbbbbbbbbb");
  });

  it("reports the unknown sentinel rather than omitting the field", async () => {
    // Omission already means "you have this one". An unbuilt daemon has to be
    // able to say so out loud, or a client would sit forever without a baseline
    // while reading the silence as agreement.
    serverBuildId = UNKNOWN_BUILD_ID;
    const body = await poll({ v: "7", mv: "3" });
    expect(body.build).toBe(UNKNOWN_BUILD_ID);
  });

  it("leaves the existing counters and payloads untouched", async () => {
    // The field is additive; a client that ignores it must see exactly the
    // response it saw before. First poll, so sessions and summons come too.
    const body = await poll({});
    expect(body.version).toBe(7);
    expect(body.metadataVersion).toBe(3);
    expect(body.sessions).toEqual({});
    expect(body.activeSummons).toEqual({});
  });

  it("does not mistake a repeated non-string query param for an echo", async () => {
    // Express hands back an array when `?b=x&b=y` is sent. That is not an id,
    // and treating it as one would compare an array to a string and quietly
    // resend — harmless here, but the coercion is what to be explicit about.
    const body = await poll({ b: ["a", "b"] as any });
    expect(body.build).toBe("1.0.0-alpha.49+gaaaaaaaaaaaa");
  });
});

describe("readBuildIdFrom", () => {
  const dist = join(tmpRoot, "dist");
  mkdirSync(dist, { recursive: true });

  it("reads the id vite emitted beside the bundle", () => {
    writeFileSync(join(dist, "build-id.json"), JSON.stringify({ buildId: "1.0.0-alpha.49+gcccccccccccc" }));
    expect(readBuildIdFrom(dist)).toBe("1.0.0-alpha.49+gcccccccccccc");
  });

  it("says unknown when there is no built frontend at all", () => {
    expect(readBuildIdFrom(join(tmpRoot, "never-built"))).toBe(UNKNOWN_BUILD_ID);
  });

  it("says unknown for a file it cannot make sense of", () => {
    writeFileSync(join(dist, "build-id.json"), "{ truncated");
    expect(readBuildIdFrom(dist)).toBe(UNKNOWN_BUILD_ID);

    writeFileSync(join(dist, "build-id.json"), JSON.stringify({ buildId: 42 }));
    expect(readBuildIdFrom(dist)).toBe(UNKNOWN_BUILD_ID);

    writeFileSync(join(dist, "build-id.json"), JSON.stringify({ buildId: "" }));
    expect(readBuildIdFrom(dist)).toBe(UNKNOWN_BUILD_ID);
  });
});
