/**
 * Route-level tests for the favorites lists (`favoriteSkills` / `favoriteJobs`)
 * on PUT /api/agent-settings.
 *
 * Three things distinguish these from the other settings fields and are what
 * these tests pin down:
 *
 *  1. **Order is data.** The arrays are the display order on the New Chat
 *     launchpad, so the write path must not sort or set-ify them.
 *  2. **`[]` clears, malformed input does not.** Un-starring the last entry
 *     sends an empty array and must remove the key, but a body that is not an
 *     array at all (a truncated request, an older client) must leave the
 *     stored list alone rather than silently wiping the user's favorites.
 *  3. **Unrelated saves leave them be** — the same partial-update property the
 *     proxy fields have, applied to a field the UI writes from three places.
 *
 * Driven the same way as agent-settings.partial-update.test.ts: the handler is
 * pulled off the router stack and called with a fake req/res, with the save's
 * fan-out (daemon, tunnels, catalog refreshes) stubbed.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-agent-settings-favorites-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
const SETTINGS_FILE = join(tmpRoot, "agent-settings.json");

vi.mock("../services/proxy-singleton.js", () => ({
  switchProxyMode: async () => {},
  testRemoteConnection: async () => ({ status: "connected", message: "" }),
  getConfiguredAliases: () => [],
  resetAllClients: () => {},
  resetClient: () => {},
}));
vi.mock("../services/local-daemon.js", () => ({ getLocalDaemonStatus: () => ({}), fetchDaemonHealth: async () => null }));
vi.mock("../services/web-tunnel.js", () => ({
  startWebTunnel: async () => {},
  stopWebTunnel: async () => {},
  getWebTunnelStatus: () => ({ running: false }),
  isCloudflaredAvailable: () => false,
  resolveCallboardPort: () => 8000,
}));
vi.mock("../services/sdk-info.js", () => ({ refreshSdkInfoCache: async () => {} }));
vi.mock("../services/codex-models.js", () => ({ refreshCodexModelsCache: async () => {} }));

const { agentSettingsRouter } = await import("./agent-settings.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const putHandler = (agentSettingsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.put).route.stack[0].handle as (
  req: Request,
  res: Response,
) => Promise<void>;

function put(body: unknown): Promise<{ code: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    void putHandler({ body, headers: {}, socket: {} } as unknown as Request, res as unknown as Response);
  });
}

const onDisk = () => JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));

/** A user with two skills and one job already starred, in a chosen order. */
const STARRED = {
  proxyMode: "local",
  favoriteSkills: ["release-notes", "bug-triage"],
  favoriteJobs: ["bake-devin-pr"],
};

beforeEach(() => {
  writeFileSync(SETTINGS_FILE, JSON.stringify(STARRED, null, 2));
});

describe("PUT /api/agent-settings — favorites", () => {
  it("stores the list verbatim, preserving the user's order", async () => {
    const res = await put({ favoriteSkills: ["bug-triage", "release-notes", "changelog"] });
    expect(res.code).toBe(200);
    // Not sorted, not deduped into a Set's iteration order — exactly as sent.
    expect(onDisk().favoriteSkills).toEqual(["bug-triage", "release-notes", "changelog"]);
  });

  it("trims entries and drops blanks and repeats without reordering", async () => {
    await put({ favoriteJobs: ["  nightly  ", "", "nightly", "weekly", 7, null] });
    expect(onDisk().favoriteJobs).toEqual(["nightly", "weekly"]);
  });

  it("clears the setting when the last star is removed", async () => {
    await put({ favoriteSkills: [] });
    // Removed, not persisted as `[]` — an empty array and an absent key must
    // not be two ways to say the same thing in the stored file.
    expect("favoriteSkills" in onDisk()).toBe(false);
    // The other list is untouched.
    expect(onDisk().favoriteJobs).toEqual(["bake-devin-pr"]);
  });

  it("leaves a stored list alone when the body sends a non-array", async () => {
    await put({ favoriteSkills: null, favoriteJobs: "bake-devin-pr" });
    expect(onDisk().favoriteSkills).toEqual(["release-notes", "bug-triage"]);
    expect(onDisk().favoriteJobs).toEqual(["bake-devin-pr"]);
  });

  it("survives an unrelated save", async () => {
    await put({ openRouterApiKey: "sk-or-test" });
    const saved = onDisk();
    expect(saved.favoriteSkills).toEqual(["release-notes", "bug-triage"]);
    expect(saved.favoriteJobs).toEqual(["bake-devin-pr"]);
  });

  it("does not validate against the live skill/job lists", async () => {
    // A favorite naming something that no longer exists is normal (rename a
    // skill and the old name outlives it). Readers filter; the write path
    // never prunes, so a transient read failure cannot destroy a favorite.
    await put({ favoriteSkills: ["a-skill-that-does-not-exist"] });
    expect(onDisk().favoriteSkills).toEqual(["a-skill-that-does-not-exist"]);
  });
});
