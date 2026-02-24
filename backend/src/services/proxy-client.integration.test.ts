/**
 * Integration tests for ProxyClient → drawlatch remote server.
 *
 * These tests make real calls to the proxy server using the encrypted
 * Ed25519/X25519 channel. They require:
 *   1. drawlatch remote server running (default: http://127.0.0.1:9999)
 *   2. An authorized client keypair
 *   3. The remote server's public keys
 *
 * Key discovery order (first match wins):
 *   - Env vars: EVENT_WATCHER_KEYS_DIR / EVENT_WATCHER_REMOTE_KEYS_DIR
 *   - drawlatch project keys: ~/drawlatch/.drawlatch/keys/
 *   - Home directory keys: ~/.drawlatch/keys/
 *
 * Skip these tests in CI or when the proxy is not available by setting:
 *   SKIP_PROXY_TESTS=true
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ProxyClient } from "./proxy-client.js";

// ── Key discovery ──────────────────────────────────────────────────────

function findKeys(): { keysDir: string; remoteKeysDir: string } | null {
  // Explicit env vars take priority
  if (process.env.EVENT_WATCHER_KEYS_DIR && process.env.EVENT_WATCHER_REMOTE_KEYS_DIR) {
    const k = process.env.EVENT_WATCHER_KEYS_DIR;
    const r = process.env.EVENT_WATCHER_REMOTE_KEYS_DIR;
    if (existsSync(k) && existsSync(r)) return { keysDir: k, remoteKeysDir: r };
  }

  // Common key locations to try (client keys dir, remote server pubkey dir)
  const candidates: [string, string][] = [
    // drawlatch project-local keys (dev/test setup)
    [join(homedir(), "drawlatch/.drawlatch/keys/local"), join(homedir(), "drawlatch/.drawlatch/keys/remote")],
    // Home directory keys (production MCP plugin setup)
    [join(homedir(), ".drawlatch/keys/local"), join(homedir(), ".drawlatch/keys/peers/remote-server")],
  ];

  for (const [k, r] of candidates) {
    if (existsSync(k) && existsSync(r) && existsSync(join(k, "signing.key.pem")) && existsSync(join(r, "signing.pub.pem"))) {
      return { keysDir: k, remoteKeysDir: r };
    }
  }
  return null;
}

// ── Configuration ──────────────────────────────────────────────────────

const REMOTE_URL = process.env.EVENT_WATCHER_REMOTE_URL || "http://127.0.0.1:9999";
const keyPaths = findKeys();

// ── Skip detection ─────────────────────────────────────────────────────

const SKIP = process.env.SKIP_PROXY_TESTS === "true";
const keysExist = keyPaths !== null;

function canReachServer(): Promise<boolean> {
  return fetch(`${REMOTE_URL}/health`)
    .then(() => true)
    .catch(() => {
      // Try handshake endpoint — some setups don't have /health
      return fetch(REMOTE_URL, { method: "HEAD" })
        .then(() => true)
        .catch(() => false);
    });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe.skipIf(SKIP || !keysExist)("ProxyClient integration", () => {
  let client: ProxyClient;
  let serverReachable: boolean;

  beforeAll(async () => {
    serverReachable = await canReachServer();
    if (!serverReachable || !keyPaths) return;
    client = new ProxyClient(REMOTE_URL, keyPaths.keysDir, keyPaths.remoteKeysDir);
  });

  describe("handshake", () => {
    it.skipIf(!keysExist)("completes the Ed25519/X25519 handshake", async () => {
      if (!serverReachable) return;

      await client.handshake();
      expect(client.isConnected).toBe(true);
    });

    it.skipIf(!keysExist)("can reset and re-handshake", async () => {
      if (!serverReachable) return;

      client.reset();
      expect(client.isConnected).toBe(false);

      // Next callTool will auto-handshake
      const result = await client.callTool("list_routes");
      expect(client.isConnected).toBe(true);
      expect(result).toBeDefined();
    });
  });

  describe("list_routes", () => {
    it("returns an array of route objects", async () => {
      if (!serverReachable) return;

      const result = await client.callTool("list_routes");

      expect(Array.isArray(result)).toBe(true);

      const routes = result as Record<string, unknown>[];
      // There should be at least one route configured
      expect(routes.length).toBeGreaterThan(0);

      // Each route should have the expected shape
      for (const route of routes) {
        expect(route).toHaveProperty("index");
        expect(typeof route.index).toBe("number");
        expect(route).toHaveProperty("allowedEndpoints");
        expect(Array.isArray(route.allowedEndpoints)).toBe(true);
        expect(route).toHaveProperty("secretNames");
        expect(Array.isArray(route.secretNames)).toBe(true);
        expect(route).toHaveProperty("autoHeaders");
        expect(Array.isArray(route.autoHeaders)).toBe(true);
      }
    });

    it("routes have optional name and description fields", async () => {
      if (!serverReachable) return;

      const routes = (await client.callTool("list_routes")) as Record<string, unknown>[];

      for (const route of routes) {
        // name and description are optional but when present should be strings
        if (route.name !== undefined) {
          expect(typeof route.name).toBe("string");
        }
        if (route.description !== undefined) {
          expect(typeof route.description).toBe("string");
        }
        if (route.docsUrl !== undefined) {
          expect(typeof route.docsUrl).toBe("string");
        }
      }
    });
  });

  describe("ingestor_status", () => {
    it("returns an array of ingestor statuses", async () => {
      if (!serverReachable) return;

      const result = await client.callTool("ingestor_status");

      expect(Array.isArray(result)).toBe(true);

      const statuses = result as Record<string, unknown>[];

      // Each status should have the expected shape
      for (const status of statuses) {
        expect(status).toHaveProperty("connection");
        expect(typeof status.connection).toBe("string");

        expect(status).toHaveProperty("type");
        expect(["websocket", "webhook", "poll"]).toContain(status.type);

        expect(status).toHaveProperty("state");
        expect(typeof status.state).toBe("string");

        expect(status).toHaveProperty("bufferedEvents");
        expect(typeof status.bufferedEvents).toBe("number");

        expect(status).toHaveProperty("totalEventsReceived");
        expect(typeof status.totalEventsReceived).toBe("number");

        expect(status).toHaveProperty("lastEventAt");
        // lastEventAt is string | null
        expect(status.lastEventAt === null || typeof status.lastEventAt === "string").toBe(true);
      }
    });

    it("ingestors have valid state values", async () => {
      if (!serverReachable) return;

      const statuses = (await client.callTool("ingestor_status")) as Record<string, unknown>[];
      const validStates = ["starting", "connected", "reconnecting", "stopped", "error"];

      for (const status of statuses) {
        expect(validStates).toContain(status.state);
      }
    });
  });

  describe("poll_events", () => {
    it("returns events when called with after_id=-1", async () => {
      if (!serverReachable) return;

      const result = await client.callTool("poll_events", { after_id: -1 });

      // poll_events may return array directly or wrapped in { events: [] }
      const events: unknown[] = Array.isArray(result) ? result : ((result as Record<string, unknown>)?.events as unknown[]) || [];

      expect(Array.isArray(events)).toBe(true);

      // Events may be empty if no events have been received yet
      for (const event of events) {
        const e = event as Record<string, unknown>;
        expect(e).toHaveProperty("id");
        expect(typeof e.id).toBe("number");

        expect(e).toHaveProperty("receivedAt");
        expect(typeof e.receivedAt).toBe("string");

        expect(e).toHaveProperty("source");
        expect(typeof e.source).toBe("string");

        expect(e).toHaveProperty("eventType");
        expect(typeof e.eventType).toBe("string");

        expect(e).toHaveProperty("data");
      }
    });

    it("returns empty array when called with a high cursor", async () => {
      if (!serverReachable) return;

      const result = await client.callTool("poll_events", { after_id: 999999999 });
      const events: unknown[] = Array.isArray(result) ? result : ((result as Record<string, unknown>)?.events as unknown[]) || [];

      expect(events.length).toBe(0);
    });

    it("supports filtering by connection alias", async () => {
      if (!serverReachable) return;

      // This should not error even if the connection doesn't exist
      const result = await client.callTool("poll_events", {
        after_id: -1,
        connection: "nonexistent-connection",
      });

      const events: unknown[] = Array.isArray(result) ? result : ((result as Record<string, unknown>)?.events as unknown[]) || [];

      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBe(0);
    });
  });

  describe("session reuse", () => {
    it("reuses the encrypted session across multiple calls", async () => {
      if (!serverReachable) return;

      // Make multiple calls — they should all succeed using the same session
      const r1 = await client.callTool("list_routes");
      const r2 = await client.callTool("ingestor_status");
      const r3 = await client.callTool("poll_events", { after_id: -1 });

      expect(Array.isArray(r1)).toBe(true);
      expect(Array.isArray(r2)).toBe(true);
      // r3 may be array or wrapped
      expect(r3).toBeDefined();
      expect(client.isConnected).toBe(true);
    });
  });
});
