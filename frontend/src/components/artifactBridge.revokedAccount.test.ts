// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

/**
 * The bridge's default budget is an account of the module-scope tab budget,
 * opened lazily on the first metered request and closed on revoke. This file
 * counts the opens and closes through that real module, which the other
 * bridge tests (each with a budget of its own) cannot see.
 */
const books = vi.hoisted(() => ({ opened: 0, closed: 0 }));
vi.mock("./artifactBudget", async (orig) => {
  const m = await orig<typeof import("./artifactBudget")>();
  const real = m.createTabBudget();
  return {
    ...m,
    tabBudget: {
      open(group?: string) {
        books.opened++;
        const a = real.open(group);
        return {
          ...a,
          close: () => {
            books.closed++;
            a.close();
          },
        };
      },
    },
  };
});

import { createArtifactBridge, BRIDGE_HELLO, BRIDGE_REPLY, BRIDGE_REQUEST } from "./artifactBridge";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("artifact bridge — its budget account after revoke", () => {
  it("a request whose shared check is still in flight at unmount opens no account and reaches no server once it lands", async () => {
    const frame = { postMessage: vi.fn() };
    const api = { list: vi.fn(async () => []), readText: vi.fn(), readBlob: vi.fn(), write: vi.fn(), remove: vi.fn() };
    let release!: (v: "readwrite") => void;
    // Another mount's check of the artifact, in flight: the lookup hands it back without touching this mount's budget.
    const inflight = new Promise<"readwrite">((r) => (release = r));
    const bridge = createArtifactBridge({
      getFrameWindow: () => frame as unknown as Window,
      storageKey: "k",
      access: "readwrite",
      api,
      token: TOKEN,
      recheck: () => inflight,
      budgetGroup: "art",
    });
    const port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null as null | ((e: MessageEvent) => void) };
    bridge.handleMessage({ source: frame, data: { __callboard: BRIDGE_HELLO, token: TOKEN }, ports: [port] } as unknown as MessageEvent);
    port.onmessage!({ data: { __callboard: BRIDGE_REQUEST, token: TOKEN, id: "1", op: "list" } } as MessageEvent);
    await Promise.resolve();
    expect(books.opened).toBe(0);
    bridge.revoke();
    release("readwrite");
    await bridge.settled();
    expect(books).toEqual({ opened: 0, closed: 0 });
    expect(api.list).not.toHaveBeenCalled();
    expect(port.postMessage.mock.calls.filter(([m]) => m.__callboard === BRIDGE_REPLY)).toEqual([]);
  });

  it("an account opened before revoke is closed by it", async () => {
    const frame = { postMessage: vi.fn() };
    const api = { list: vi.fn(async () => []), readText: vi.fn(), readBlob: vi.fn(), write: vi.fn(), remove: vi.fn() };
    const bridge = createArtifactBridge({ getFrameWindow: () => frame as unknown as Window, storageKey: "k", access: "read", api, token: TOKEN });
    const port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null as null | ((e: MessageEvent) => void) };
    bridge.handleMessage({ source: frame, data: { __callboard: BRIDGE_HELLO, token: TOKEN }, ports: [port] } as unknown as MessageEvent);
    const before = { ...books };
    port.onmessage!({ data: { __callboard: BRIDGE_REQUEST, token: TOKEN, id: "1", op: "list" } } as MessageEvent);
    await bridge.settled();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(books.opened - before.opened).toBe(1);
    bridge.revoke();
    expect(books.closed - before.closed).toBe(1);
  });
});
