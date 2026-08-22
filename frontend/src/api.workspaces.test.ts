/**
 * What the workspace calls actually put on the wire.
 *
 * Every other test of this surface mocks `../api` wholesale, which is right for
 * testing a component and useless for testing the request itself. These assert
 * the URL, because for one parameter the URL *is* the behaviour:
 *
 * > `includeRemovability=false` is the only thing standing between this app and
 * > ~1.5s of frozen daemon per listing. The route defaults that parameter to
 * > **true** — deliberately, as a compatibility shim for browser tabs running a
 * > bundle from before the verdict was splittable — so a caller that stops
 * > sending it does not get an error, or a type failure, or a different shape.
 * > It gets the old slow path back, silently, with every other test still green.
 *
 * That is exactly the shape of regression a test suite is supposed to catch and
 * this one could not, so: one assertion on the emitted query string, and a
 * matching one for the opt-in call, so neither can drift into the other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWorkspaceRemovability, listWorkspaces, listWorkspacesWithVerdicts } from "./api";

const fetchMock = vi.fn();

/** The URL of the single request the call under test made. */
function requestedUrl(): URL {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // Relative to a base only so `URLSearchParams` is available; the assertions
  // below are all about path and query, never the origin.
  return new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ workspaces: [] }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("listWorkspaces", () => {
  /**
   * The one that matters. Mutation-check by deleting the parameter from
   * `workspaceListing` in api.ts — this must go red.
   */
  it("declines the removal verdict explicitly, because the route's default is on", async () => {
    await listWorkspaces("active", true);

    const url = requestedUrl();
    expect(url.pathname).toBe("/api/workspaces");
    expect(url.searchParams.get("includeRemovability")).toBe("false");
  });

  it("still declines it when no other parameter is passed", async () => {
    // The parameter is unconditional, not something that rides along with a
    // status filter or a disk-usage request.
    await listWorkspaces();

    expect(requestedUrl().searchParams.get("includeRemovability")).toBe("false");
  });

  it("passes the status filter and keeps disk usage opt-in", async () => {
    await listWorkspaces("active", true);
    let url = requestedUrl();
    expect(url.searchParams.get("status")).toBe("active");
    expect(url.searchParams.get("includeDiskUsage")).toBe("true");

    fetchMock.mockClear();
    await listWorkspaces("archived");
    url = requestedUrl();
    expect(url.searchParams.get("status")).toBe("archived");
    expect(url.searchParams.has("includeDiskUsage")).toBe(false);
  });

  it("surfaces the server's own message when the listing fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "Failed to list workspaces: boom" }) });
    await expect(listWorkspaces("active")).rejects.toThrow("Failed to list workspaces: boom");
  });
});

describe("listWorkspacesWithVerdicts", () => {
  /**
   * The opposite value on the same parameter, so the two calls cannot quietly
   * collapse into one. This is the expensive listing; it must say so.
   */
  it("asks for the verdict outright", async () => {
    await listWorkspacesWithVerdicts("active", true);

    const url = requestedUrl();
    expect(url.pathname).toBe("/api/workspaces");
    expect(url.searchParams.get("includeRemovability")).toBe("true");
    expect(url.searchParams.get("status")).toBe("active");
  });
});

describe("fetchWorkspaceRemovability", () => {
  it("asks the per-workspace route, and runs no disk-usage measurement", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ workspace: { id: "ws-1" } }) });

    const workspace = await fetchWorkspaceRemovability("ws-1");

    const url = requestedUrl();
    expect(url.pathname).toBe("/api/workspaces/ws-1/removability");
    // `du` on the click path is what this whole split exists to avoid; the
    // listing's memoised measurement is reused instead.
    expect(url.searchParams.has("includeDiskUsage")).toBe(false);
    // Unwrapped from the response envelope, so callers get the record itself.
    expect(workspace).toEqual({ id: "ws-1" });
  });
});
