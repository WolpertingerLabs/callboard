import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, deserializePublicKeys } from "@wolpertingerlabs/drawlatch/shared/crypto";

// getRemoteMcpConfigDir is the only external dependency — point it at a temp dir.
let configDir = "";
vi.mock("./agent-settings.js", () => ({
  getRemoteMcpConfigDir: () => configDir,
}));

import { inspectBundle, importBundle, BundleImportError } from "./bundle-import.js";

// ── Bundle builders (mirror drawlatch's issued format) ───────────────

function pemKeypair() {
  const signing = crypto.generateKeyPairSync("ed25519");
  const exchange = crypto.generateKeyPairSync("x25519");
  return {
    signing: {
      pub: signing.publicKey.export({ type: "spki", format: "pem" }) as string,
      priv: signing.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    },
    exchange: {
      pub: exchange.publicKey.export({ type: "spki", format: "pem" }) as string,
      priv: exchange.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    },
  };
}

function fpOf(signingPub: string, exchangePub: string): string {
  return fingerprint(deserializePublicKeys({ signing: signingPub, exchange: exchangePub }));
}

// scrypt + AES-256-GCM wrap, byte-identical to drawlatch's caller-bundle-crypto.
function wrap(plaintext: string, passphrase: string, salt: Buffer, n: number, r: number, p: number): string {
  const key = crypto.scryptSync(passphrase, salt, 32, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function buildBundle(opts: { alias?: string; passphrase?: string } = {}) {
  const alias = opts.alias ?? "callboard-prod";
  const caller = pemKeypair();
  const server = pemKeypair();
  const encryption = opts.passphrase
    ? { kdf: "scrypt" as const, salt: crypto.randomBytes(16).toString("base64"), n: 16384, r: 8, p: 1, alg: "aes-256-gcm" as const }
    : null;

  let signingPriv = caller.signing.priv;
  let exchangePriv = caller.exchange.priv;
  if (encryption) {
    const salt = Buffer.from(encryption.salt, "base64");
    signingPriv = wrap(caller.signing.priv, opts.passphrase!, salt, encryption.n, encryption.r, encryption.p);
    exchangePriv = wrap(caller.exchange.priv, opts.passphrase!, salt, encryption.n, encryption.r, encryption.p);
  }

  return {
    version: 1,
    callerAlias: alias,
    fingerprint: fpOf(caller.signing.pub, caller.exchange.pub),
    createdAt: "2026-06-17T14:00:00Z",
    expiresAt: null,
    endpointUrl: "https://drawlatch.example.com",
    serverKeyFingerprint: fpOf(server.signing.pub, server.exchange.pub),
    connections: ["github"],
    caller: {
      signing: { priv: signingPriv, pub: caller.signing.pub },
      exchange: { priv: exchangePriv, pub: caller.exchange.pub },
    },
    server: {
      signing: { pub: server.signing.pub },
      exchange: { pub: server.exchange.pub },
    },
    encryption,
  };
}

// Octal permission bits of a file (last 3 digits).
function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

describe("bundle-import", () => {
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "cb-bundle-"));
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  describe("inspectBundle", () => {
    it("returns the plaintext fields for a valid bundle", () => {
      const parsed = inspectBundle(buildBundle());
      expect(parsed.alias).toBe("callboard-prod");
      expect(parsed.endpointUrl).toBe("https://drawlatch.example.com");
      expect(parsed.encrypted).toBe(false);
      expect(parsed.fingerprint).toMatch(/^[0-9a-f:]+$/);
    });

    it("flags passphrase-wrapped bundles", () => {
      expect(inspectBundle(buildBundle({ passphrase: "pw" })).encrypted).toBe(true);
    });

    it("rejects a wrong version", () => {
      expect(() => inspectBundle({ ...buildBundle(), version: 2 })).toThrow(/version/i);
    });

    it("rejects an invalid alias", () => {
      expect(() => inspectBundle({ ...buildBundle(), callerAlias: "../evil" })).toThrow(BundleImportError);
    });

    it("rejects a tampered caller fingerprint", () => {
      expect(() => inspectBundle({ ...buildBundle(), fingerprint: "00:11:22" })).toThrow(/caller fingerprint/i);
    });

    it("rejects a tampered server fingerprint", () => {
      expect(() => inspectBundle({ ...buildBundle(), serverKeyFingerprint: "00:11:22" })).toThrow(/server fingerprint/i);
    });
  });

  describe("importBundle", () => {
    it("writes caller + server keys with restrictive perms", () => {
      const bundle = buildBundle({ alias: "agent-x" });
      const result = importBundle(bundle);

      expect(result.alias).toBe("agent-x");
      expect(result.endpointUrl).toBe("https://drawlatch.example.com");

      const callerDir = join(configDir, "keys", "callers", "agent-x");
      const serverDir = join(configDir, "keys", "server");

      // Public keys 0644, private keys 0600.
      expect(mode(join(callerDir, "signing.pub.pem"))).toBe("644");
      expect(mode(join(callerDir, "exchange.pub.pem"))).toBe("644");
      expect(mode(join(callerDir, "signing.key.pem"))).toBe("600");
      expect(mode(join(callerDir, "exchange.key.pem"))).toBe("600");
      expect(mode(join(serverDir, "signing.pub.pem"))).toBe("644");

      // Private keys land as plaintext PEM and parse.
      const priv = readFileSync(join(callerDir, "signing.key.pem"), "utf-8");
      expect(priv).toContain("PRIVATE KEY");
      expect(() => crypto.createPrivateKey(priv)).not.toThrow();
    });

    it("decrypts passphrase-wrapped private keys with the right passphrase", () => {
      const bundle = buildBundle({ alias: "wrapped", passphrase: "correct horse" });
      importBundle(bundle, "correct horse");
      const priv = readFileSync(join(configDir, "keys", "callers", "wrapped", "signing.key.pem"), "utf-8");
      expect(priv).toContain("PRIVATE KEY");
      expect(() => crypto.createPrivateKey(priv)).not.toThrow();
    });

    it("requires a passphrase for wrapped bundles", () => {
      const bundle = buildBundle({ passphrase: "pw" });
      expect(() => importBundle(bundle)).toThrow(/passphrase is required/i);
      try {
        importBundle(bundle);
      } catch (e) {
        expect((e as BundleImportError).status).toBe(422);
      }
    });

    it("rejects a wrong passphrase without writing keys", () => {
      const bundle = buildBundle({ alias: "wrapped2", passphrase: "right" });
      expect(() => importBundle(bundle, "wrong")).toThrow(/wrong passphrase|corrupt/i);
    });
  });
});
