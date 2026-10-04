/**
 * ProxyClient concurrency: replies must be decrypted with the session the
 * request was encrypted with, and a stale-channel failure may only drop the
 * shared session if it is still the one that request used.
 *
 * drawlatch's crypto and fetch are mocked. Each mock EncryptedChannel is bound
 * to its handshake's session id and fails to decrypt anything else with the
 * real channel's error message, so a mismatched channel looks exactly like a
 * stale one. Every /request POST stays pending until the test answers it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@wolpertingerlabs/drawlatch/shared/crypto", () => {
  class EncryptedChannel {
    readonly sessionId: string;
    constructor(keys: { sessionId: string }) {
      this.sessionId = keys.sessionId;
    }
    encryptJSON(obj: unknown): Buffer {
      return Buffer.from(JSON.stringify({ session: this.sessionId, obj }));
    }
    decryptJSON<T>(buf: Buffer): T {
      const parsed = JSON.parse(buf.toString());
      if (parsed.session !== this.sessionId) {
        throw new Error("Decryption failed: authentication tag mismatch (tampered or wrong key)");
      }
      return parsed.obj as T;
    }
  }
  return { loadKeyBundle: () => ({}), loadPublicKeys: () => ({}), EncryptedChannel };
});

let handshakes = 0;
vi.mock("@wolpertingerlabs/drawlatch/shared/protocol", () => {
  class HandshakeInitiator {
    createInit() {
      return {};
    }
    processReply() {
      return { sessionId: `s${++handshakes}` };
    }
    createFinish() {
      return {};
    }
  }
  return { HandshakeInitiator };
});

import { ProxyClient } from "./proxy-client.js";

interface Sent {
  session: string;
  toolName: string;
  requestId: string;
  respond: (res: Response) => void;
  fail: (err: Error) => void;
  signal?: AbortSignal;
}

let sent: Sent[];

function hubReply(sent: Sent, result: unknown): Response {
  const body = { session: sent.session, obj: { type: "proxy_response", id: sent.requestId, success: true, result, timestamp: 0 } };
  return new Response(new Uint8Array(Buffer.from(JSON.stringify(body))), { status: 200 });
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  handshakes = 0;
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/handshake/init")) return new Response(JSON.stringify({}), { status: 200 });
      if (url.endsWith("/handshake/finish")) return new Response("", { status: 200 });
      const parsed = JSON.parse(Buffer.from(init.body as Uint8Array).toString());
      expect(parsed.session).toBe((init.headers as Record<string, string>)["X-Session-Id"]);
      return new Promise<Response>((respond, fail) => {
        const signal = init.signal ?? undefined;
        sent.push({ session: parsed.session, toolName: parsed.obj.toolName, requestId: parsed.obj.id, respond, fail, signal });
        signal?.addEventListener("abort", () => fail(signal.reason ?? new DOMException("aborted", "AbortError")));
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProxyClient session capture", () => {
  it("a stale reply on one call does not make a concurrent POST execute twice", async () => {
    const client = new ProxyClient("http://hub", "/k", "/p");

    // 1. A long-poll is held on session s1.
    const wait = client.callTool("wait_for_events", { cursors: {} });
    await flush();
    expect(sent.map((s) => `${s.toolName}@${s.session}`)).toEqual(["wait_for_events@s1"]);

    // 2. A chat http_request hits s1's expiry (401), rehandshakes to s2, and the hub runs it there.
    const post = client.callTool("http_request", { method: "POST", url: "https://example.test" });
    await flush();
    sent[1].respond(new Response("Unknown or expired session", { status: 401 }));
    await flush();
    expect(sent.map((s) => `${s.toolName}@${s.session}`)).toEqual(["wait_for_events@s1", "http_request@s1", "http_request@s2"]);

    // 3. The wait's reply arrives, encrypted for s1 — the session it was sent on.
    sent[0].respond(hubReply(sent[0], { streams: {} }));
    await flush();

    // 4. The POST's reply arrives, encrypted for s2.
    sent[2].respond(hubReply(sent[2], { status: 201 }));
    await flush();

    // Executed exactly once on a live session; never re-sent.
    expect(sent.filter((s) => s.toolName === "http_request").map((s) => s.session)).toEqual(["s1", "s2"]);
    expect(sent).toHaveLength(3);
    await expect(wait).resolves.toEqual({ streams: {} });
    await expect(post).resolves.toEqual({ status: 201 });
  });

  it("a genuinely stale reply still drops the session it was sent on and rehandshakes", async () => {
    const client = new ProxyClient("http://hub", "/k", "/p");
    const call = client.callTool("list_routes");
    await flush();
    // The hub answers with a reply this session can't decrypt (e.g. hub restarted).
    sent[0].respond(hubReply({ ...sent[0], session: "elsewhere" }, []));
    await flush();
    expect(sent.map((s) => `${s.toolName}@${s.session}`)).toEqual(["list_routes@s1", "list_routes@s2"]);
    sent[1].respond(hubReply(sent[1], ["r"]));
    await expect(call).resolves.toEqual(["r"]);
  });

  it("a stale failure on an old session does not discard a newer one", async () => {
    const client = new ProxyClient("http://hub", "/k", "/p");
    const a = client.callTool("list_routes");
    await flush();
    const b = client.callTool("ingestor_status");
    await flush();
    // b's 401 moves the client to s2; then a's s1 reply turns out undecryptable.
    sent[1].respond(new Response("", { status: 401 }));
    await flush();
    sent[0].respond(hubReply({ ...sent[0], session: "elsewhere" }, []));
    await flush();
    // a retries on the current session s2 rather than forcing a third handshake.
    expect(sent.map((s) => `${s.toolName}@${s.session}`)).toEqual(["list_routes@s1", "ingestor_status@s1", "ingestor_status@s2", "list_routes@s2"]);
    expect(handshakes).toBe(2);
    sent[2].respond(hubReply(sent[2], []));
    sent[3].respond(hubReply(sent[3], []));
    await expect(Promise.all([a, b])).resolves.toEqual([[], []]);
  });
});

describe("ProxyClient abort", () => {
  it("aborting rejects the in-flight call without retrying it", async () => {
    const client = new ProxyClient("http://hub", "/k", "/p");
    const controller = new AbortController();
    const call = client.callTool("wait_for_events", { cursors: {} }, { signal: controller.signal });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].signal).toBe(controller.signal);

    controller.abort();
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("aborting during a 429 backoff ends the call without waiting out the sleep", async () => {
    const client = new ProxyClient("http://hub", "/k", "/p");
    const controller = new AbortController();
    const call = client.callTool("wait_for_events", { cursors: {} }, { signal: controller.signal });
    await flush();
    sent[0].respond(new Response("Rate limit exceeded", { status: 429, headers: { "Retry-After": "15" } }));
    await flush();

    const started = Date.now();
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sent).toHaveLength(1);
  });

  it("an already-aborted signal sends nothing", async () => {
    const client = new ProxyClient("http://hub", "/k", "/p");
    const controller = new AbortController();
    controller.abort();
    await expect(client.callTool("poll_events", {}, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(sent).toHaveLength(0);
  });
});
