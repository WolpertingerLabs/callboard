import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recheckGrant } from "./artifactGrant";
import { createSharedLookup, RateLimitedError } from "./artifactBudget";
import { getArtifact } from "../api";
import type { Artifact, RenderArtifactToolResult } from "../api";

/**
 * `recheckGrant` through the REAL `getArtifact` (global fetch stubbed), so the
 * response shapes are the ones the browser sees. The line it must hold: only
 * the API's own "not found" (or a changed artifact) lowers the grant; failing
 * to look — aborted, a 5xx, a 404 page that is not the API's answer, the
 * budget — throws, so the bridge refuses that one request and keeps the grant.
 */

const SHA = "a".repeat(64);
const data: RenderArtifactToolResult = {
  type: "render_artifact",
  artifact_id: "cramhouse",
  version: 3,
  sha256: SHA,
  name: "Cramhouse",
  content_type: "html",
  storage_key: "birds",
  storage_access: "readwrite",
};
const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  id: "cramhouse",
  name: "Cramhouse",
  contentType: "html",
  storageAccess: "readwrite",
  currentVersion: 3,
  created: "c",
  updated: "u",
  versions: [{ version: 3, created: "c", size: 10, sha256: SHA }],
  ...over,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fresh lookup per call, so every case really asks the (stubbed) server. */
const check = () => recheckGrant(data, SHA, 0, null, createSharedLookup((id) => getArtifact(id)));

describe("recheckGrant — transient failures keep the grant (throw), definitive answers lower it", () => {
  it("unchanged → the grant stands", async () => {
    fetchMock.mockResolvedValue(json(200, { artifact: artifact() }));
    await expect(check()).resolves.toBe("readwrite");
  });

  it.each([
    ["an aborted request", () => Promise.reject(new DOMException("The operation was aborted.", "AbortError"))],
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 500", () => Promise.resolve(json(500, { error: "boom" }))],
    ["a 429 from the server's own limiter", () => Promise.resolve(json(429, { error: "Too many requests, please try again later." }))],
    ["a 404 that is not the API's (a proxy's HTML page)", () => Promise.resolve(new Response("<h1>Not Found</h1>", { status: 404, headers: { "content-type": "text/html" } }))],
  ])("%s → throws (not 'none')", async (_label, respond) => {
    fetchMock.mockImplementation(respond);
    await expect(check()).rejects.toThrow();
  });

  it("the budget refusing the fetch → throws RateLimitedError, nothing fetched", async () => {
    await expect(recheckGrant(data, SHA, 0, { spend: () => false, retryAfterMs: () => 0, available: () => 0 }, createSharedLookup((id) => getArtifact(id)))).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the API's own 404 (the artifact was deleted) → none", async () => {
    fetchMock.mockResolvedValue(json(404, { error: "Artifact not found: cramhouse" }));
    await expect(check()).resolves.toBe("none");
  });

  it("declared access lowered → the lower grant", async () => {
    fetchMock.mockResolvedValue(json(200, { artifact: artifact({ storageAccess: "read" }) }));
    await expect(check()).resolves.toBe("read");
    fetchMock.mockResolvedValue(json(200, { artifact: artifact({ storageAccess: "none" }) }));
    await expect(check()).resolves.toBe("none");
  });

  it("replaced (sha differs from the served bytes) or the version pruned → none", async () => {
    fetchMock.mockResolvedValue(json(200, { artifact: artifact({ versions: [{ version: 3, created: "c", size: 10, sha256: "b".repeat(64) }] }) }));
    await expect(check()).resolves.toBe("none");
    fetchMock.mockResolvedValue(json(200, { artifact: artifact({ versions: [{ version: 4, created: "c", size: 10, sha256: SHA }] }) }));
    await expect(check()).resolves.toBe("none");
  });
});
