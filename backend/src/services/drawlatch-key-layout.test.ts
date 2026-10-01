/**
 * Legacy drawlatch key layout → current layout, at callboard startup.
 *
 * The regression: on an install whose config dir still has the pre-callers
 * layout (`keys/remote/` holding the daemon's own keypair), the local-daemon
 * supervisor checks `keys/server/signing.key.pem` before anything has migrated
 * it. The check misses, `drawlatch init` mints a fresh server keypair at
 * `keys/server/`, and the daemon's own boot-time migration then skips
 * `remote → server` because the target exists. Every caller pinned to the old
 * server identity stops working.
 *
 * The first test runs the real `ensureInitialized` — and so, on failure, the
 * real `drawlatch init` — against an old-layout fixture, and asserts the server
 * identity survives.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Own scratch data dir, set before paths.ts resolves DEFAULT_MCP_*_DIR.
const DATA_DIR = await vi.hoisted(async () => {
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-keylayout-data-"));
  process.env.CALLBOARD_DATA_DIR = dir;
  return dir;
});

import { generateKeyBundle, saveKeyBundle, extractPublicKeys, fingerprint, loadKeyBundle } from "@wolpertingerlabs/drawlatch/shared/crypto";
import { ensureInitialized } from "./local-daemon.js";
import { migrateDrawlatchKeyLayouts } from "./agent-settings.js";
import { DEFAULT_MCP_LOCAL_DIR, DEFAULT_MCP_REMOTE_DIR } from "../utils/paths.js";

/** Fingerprint of the keypair stored in `dir`. */
function fingerprintOf(dir: string): string {
  return fingerprint(extractPublicKeys(loadKeyBundle(dir)));
}

/**
 * An old-layout drawlatch config dir: the server keypair under keys/remote/,
 * a caller keypair under keys/local/<alias>/, peer public keys under
 * keys/peers/, and an existing remote.config.json (so the only thing the
 * init check can trip on is the key location). Returns the server fingerprint.
 */
function buildOldLayout(configDir: string): string {
  const keys = join(configDir, "keys");
  mkdirSync(keys, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, "remote.config.json"), JSON.stringify({ host: "127.0.0.1", port: 9999, callers: {} }));

  const server = generateKeyBundle();
  saveKeyBundle(server, join(keys, "remote"));
  saveKeyBundle(generateKeyBundle(), join(keys, "local", "default"));

  // peers/remote-server/ — public keys only; peers/alice/ — a peer caller's public keys.
  const peerServer = generateKeyBundle();
  saveKeyBundle(peerServer, join(keys, "peers", "remote-server"));
  saveKeyBundle(generateKeyBundle(), join(keys, "peers", "alice"));

  return fingerprint(extractPublicKeys(server));
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cb-keylayout-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(DEFAULT_MCP_LOCAL_DIR, { recursive: true, force: true });
  rmSync(DEFAULT_MCP_REMOTE_DIR, { recursive: true, force: true });
  rmSync(join(DATA_DIR, "agent-settings.json"), { force: true });
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("local daemon init on an old-layout config dir", () => {
  it("keeps the existing server identity instead of minting a new one", async () => {
    const configDir = join(scratch, ".drawlatch.local");
    const serverFp = buildOldLayout(configDir);

    await ensureInitialized(configDir);

    expect(fingerprintOf(join(configDir, "keys", "server"))).toBe(serverFp);
    expect(existsSync(join(configDir, "keys", "remote"))).toBe(false);
  }, 30_000);

  it("migrates callers and peers, and leaves key dirs owner-only", async () => {
    const configDir = join(scratch, ".drawlatch.local");
    buildOldLayout(configDir);

    await ensureInitialized(configDir);

    const keys = join(configDir, "keys");
    expect(existsSync(join(keys, "callers", "default", "signing.key.pem"))).toBe(true);
    expect(readdirSync(join(keys, "callers", "alice")).sort()).toEqual(["exchange.pub.pem", "signing.pub.pem"]);
    expect(existsSync(join(keys, "local"))).toBe(false);
    expect(existsSync(join(keys, "peers"))).toBe(false);
    for (const dir of ["server", "callers", join("callers", "alice")]) {
      expect(statSync(join(keys, dir)).mode & 0o077).toBe(0);
    }
  }, 30_000);
});

describe("migrateDrawlatchKeyLayouts (startup)", () => {
  it("migrates both the local and the remote dir", () => {
    const localFp = buildOldLayout(DEFAULT_MCP_LOCAL_DIR);
    const remoteFp = buildOldLayout(DEFAULT_MCP_REMOTE_DIR);

    migrateDrawlatchKeyLayouts();

    expect(fingerprintOf(join(DEFAULT_MCP_LOCAL_DIR, "keys", "server"))).toBe(localFp);
    expect(fingerprintOf(join(DEFAULT_MCP_REMOTE_DIR, "keys", "server"))).toBe(remoteFp);
  });

  it("also migrates a legacy per-mode override dir", () => {
    const overrideDir = join(scratch, "custom-local");
    const fp = buildOldLayout(overrideDir);
    writeFileSync(join(DATA_DIR, "agent-settings.json"), JSON.stringify({ proxyMode: "local", localMcpConfigDir: overrideDir }));

    migrateDrawlatchKeyLayouts();

    expect(fingerprintOf(join(overrideDir, "keys", "server"))).toBe(fp);
  });

  it("is idempotent, and never overwrites an existing keys/server", () => {
    const keys = join(DEFAULT_MCP_LOCAL_DIR, "keys");
    buildOldLayout(DEFAULT_MCP_LOCAL_DIR);
    // Partial state: a current-layout server keypair already exists alongside
    // the legacy one. The current one wins and the legacy dir is left alone.
    const current = generateKeyBundle();
    saveKeyBundle(current, join(keys, "server"));
    const currentFp = fingerprint(extractPublicKeys(current));

    migrateDrawlatchKeyLayouts();
    const firstPass = readFileSync(join(keys, "server", "signing.key.pem"), "utf-8");
    migrateDrawlatchKeyLayouts();

    expect(fingerprintOf(join(keys, "server"))).toBe(currentFp);
    expect(readFileSync(join(keys, "server", "signing.key.pem"), "utf-8")).toBe(firstPass);
    expect(existsSync(join(keys, "remote", "signing.key.pem"))).toBe(true);
  });

  it("is a no-op when the config dirs don't exist", () => {
    expect(() => migrateDrawlatchKeyLayouts()).not.toThrow();
    expect(existsSync(DEFAULT_MCP_LOCAL_DIR)).toBe(false);
  });
});
