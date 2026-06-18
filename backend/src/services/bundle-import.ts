/**
 * Caller credential bundle import.
 *
 * drawlatch is the sole issuer of caller key material (see the drawlatch plan
 * `caller-credential-issuance.md`). A `{alias}.drawlatch-caller.json` bundle
 * carries the caller's PRIVATE keys (a capability minted to access drawlatch,
 * shown once — the AWS IAM access-key model) plus the server's PUBLIC keys so
 * callboard can pin the server identity at import.
 *
 * This module validates a bundle and unpacks it into the active config dir:
 *   {configDir}/keys/callers/{alias}/{signing,exchange}.{key,pub}.pem  (0600/0644)
 *   {configDir}/keys/server/{signing,exchange}.pub.pem                 (0644)
 *
 * Security:
 *   - The pinned endpoint + server-key fingerprint are surfaced to the user for
 *     confirmation BEFORE this runs (the route is only called after confirm).
 *   - Private key material is NEVER logged.
 *   - Files are written atomically (temp + rename) with restrictive perms.
 *   - The caller/server fingerprints are recomputed and checked against the
 *     bundle's own claims (tamper / corruption detection) using drawlatch's
 *     exact fingerprint algorithm, keeping the two sides in lock-step.
 */
import crypto from "node:crypto";
import { writeFileSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { CALLER_ALIAS_REGEX } from "@wolpertingerlabs/drawlatch/remote/caller-bootstrap";
import { fingerprint, deserializePublicKeys } from "@wolpertingerlabs/drawlatch/shared/crypto";
import type { CallerBundleV1, BundleEncryption } from "@wolpertingerlabs/drawlatch/remote/admin-types";
import { getActiveMcpConfigDir } from "./agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("bundle-import");

// ── Passphrase unwrap (mirrors drawlatch's caller-bundle-crypto) ─────
// Wire format: base64(IV[12] || authTag[16] || ciphertext); scrypt KDF with the
// N/r/p + salt recorded in the bundle's `encryption` block. Reimplemented here
// (rather than imported) because drawlatch does not export the crypto helper
// through a package subpath — only the format types are shared.
const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM nonce
const TAG_LEN = 16; // GCM auth tag
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function deriveBundleKey(passphrase: string, enc: BundleEncryption): Buffer {
  return crypto.scryptSync(passphrase, Buffer.from(enc.salt, "base64"), KEY_LEN, {
    N: enc.n,
    r: enc.r,
    p: enc.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

function decryptBundleField(wrapped: string, key: Buffer): string {
  const data = Buffer.from(wrapped, "base64");
  if (data.length < IV_LEN + TAG_LEN) throw new Error("Wrapped field too short");
  const iv = data.subarray(0, IV_LEN);
  const authTag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = data.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

// ── Validation ──────────────────────────────────────────────────────

/** Error carrying an HTTP status so the route can map it cleanly. */
export class BundleImportError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "BundleImportError";
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function assertPem(value: unknown, label: string, kind: "PUBLIC" | "PRIVATE"): string {
  if (!isNonEmptyString(value) || !value.includes(`${kind} KEY`)) {
    throw new BundleImportError(`Invalid bundle: ${label} is not a valid ${kind.toLowerCase()} key`);
  }
  return value;
}

export interface ParsedBundle {
  alias: string;
  fingerprint: string;
  endpointUrl: string;
  serverKeyFingerprint: string;
  /** Whether the private keys are passphrase-wrapped. */
  encrypted: boolean;
}

/**
 * Shallowly validate a bundle's plaintext, user-facing fields WITHOUT touching
 * the (possibly encrypted) private keys. Used to drive the confirmation step.
 * Throws {@link BundleImportError} on a malformed bundle.
 */
export function inspectBundle(raw: unknown): ParsedBundle {
  if (typeof raw !== "object" || raw === null) {
    throw new BundleImportError("Invalid bundle: not a JSON object");
  }
  const bundle = raw as Partial<CallerBundleV1>;

  if (bundle.version !== 1) {
    throw new BundleImportError(`Unsupported bundle version: ${String(bundle.version)} (expected 1)`);
  }
  if (!isNonEmptyString(bundle.callerAlias) || !CALLER_ALIAS_REGEX.test(bundle.callerAlias)) {
    throw new BundleImportError("Invalid bundle: callerAlias must use letters, numbers, hyphens, underscores");
  }
  if (!isNonEmptyString(bundle.endpointUrl)) {
    throw new BundleImportError("Invalid bundle: missing endpointUrl");
  }
  if (!isNonEmptyString(bundle.fingerprint) || !isNonEmptyString(bundle.serverKeyFingerprint)) {
    throw new BundleImportError("Invalid bundle: missing fingerprint(s)");
  }

  // Public keys must be present + parseable; verify the pinned fingerprints
  // match drawlatch's own algorithm so a tampered/corrupt bundle is rejected
  // before we ask for a passphrase or write anything.
  const callerSigningPub = assertPem(bundle.caller?.signing?.pub, "caller.signing.pub", "PUBLIC");
  const callerExchangePub = assertPem(bundle.caller?.exchange?.pub, "caller.exchange.pub", "PUBLIC");
  const serverSigningPub = assertPem(bundle.server?.signing?.pub, "server.signing.pub", "PUBLIC");
  const serverExchangePub = assertPem(bundle.server?.exchange?.pub, "server.exchange.pub", "PUBLIC");

  let callerFp: string;
  let serverFp: string;
  try {
    callerFp = fingerprint(deserializePublicKeys({ signing: callerSigningPub, exchange: callerExchangePub }));
    serverFp = fingerprint(deserializePublicKeys({ signing: serverSigningPub, exchange: serverExchangePub }));
  } catch {
    throw new BundleImportError("Invalid bundle: public keys could not be parsed");
  }
  if (callerFp !== bundle.fingerprint) {
    throw new BundleImportError("Bundle integrity check failed: caller fingerprint does not match its keys");
  }
  if (serverFp !== bundle.serverKeyFingerprint) {
    throw new BundleImportError("Bundle integrity check failed: server fingerprint does not match its keys");
  }

  const encryption = bundle.encryption ?? null;
  return {
    alias: bundle.callerAlias,
    fingerprint: callerFp,
    endpointUrl: bundle.endpointUrl,
    serverKeyFingerprint: serverFp,
    encrypted: encryption !== null,
  };
}

// ── Atomic file write ───────────────────────────────────────────────

function atomicWrite(filePath: string, data: string, mode: number): void {
  const tmp = `${filePath}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, filePath);
}

export interface ImportResult {
  alias: string;
  fingerprint: string;
  serverKeyFingerprint: string;
  endpointUrl: string;
  keysDir: string;
}

/**
 * Validate a bundle (decrypting passphrase-wrapped private keys if needed) and
 * unpack its key files into the active config dir. Does NOT mutate agent
 * settings or the ProxyClient cache — the route owns those side effects.
 *
 * Throws {@link BundleImportError} (with an HTTP status) on any validation,
 * passphrase, or key-parse failure.
 */
export function importBundle(raw: unknown, passphrase?: string): ImportResult {
  const meta = inspectBundle(raw);
  const bundle = raw as CallerBundleV1;

  const configDir = getActiveMcpConfigDir();
  if (!configDir) {
    throw new BundleImportError("No MCP config directory configured for the active proxy mode", 500);
  }

  // Resolve the private PEMs — plaintext, or decrypt the two wrapped fields.
  let signingPriv: string;
  let exchangePriv: string;
  if (meta.encrypted) {
    if (!isNonEmptyString(passphrase)) {
      throw new BundleImportError("This bundle is passphrase-protected — a passphrase is required", 422);
    }
    const key = deriveBundleKey(passphrase, bundle.encryption as BundleEncryption);
    try {
      signingPriv = decryptBundleField(bundle.caller.signing.priv, key);
      exchangePriv = decryptBundleField(bundle.caller.exchange.priv, key);
    } catch {
      throw new BundleImportError("Could not decrypt the bundle — wrong passphrase or corrupted file", 422);
    } finally {
      key.fill(0);
    }
  } else {
    signingPriv = bundle.caller.signing.priv;
    exchangePriv = bundle.caller.exchange.priv;
  }

  // Validate the private keys parse before writing anything (never log them).
  try {
    crypto.createPrivateKey(signingPriv);
    crypto.createPrivateKey(exchangePriv);
  } catch {
    throw new BundleImportError("Invalid bundle: caller private keys could not be parsed");
  }

  // Write the caller keypair (0600 private / 0644 public) and the server's
  // public keys (0644), each atomically.
  const callerDir = join(configDir, "keys", "callers", meta.alias);
  const serverDir = join(configDir, "keys", "server");
  mkdirSync(callerDir, { recursive: true, mode: 0o700 });
  mkdirSync(serverDir, { recursive: true, mode: 0o700 });

  atomicWrite(join(callerDir, "signing.pub.pem"), bundle.caller.signing.pub, 0o644);
  atomicWrite(join(callerDir, "exchange.pub.pem"), bundle.caller.exchange.pub, 0o644);
  atomicWrite(join(callerDir, "signing.key.pem"), signingPriv, 0o600);
  atomicWrite(join(callerDir, "exchange.key.pem"), exchangePriv, 0o600);
  atomicWrite(join(serverDir, "signing.pub.pem"), bundle.server.signing.pub, 0o644);
  atomicWrite(join(serverDir, "exchange.pub.pem"), bundle.server.exchange.pub, 0o644);

  log.info(
    `Imported caller bundle "${meta.alias}" (fingerprint ${meta.fingerprint}, ` +
      `endpoint ${meta.endpointUrl}${meta.encrypted ? ", passphrase-wrapped" : ""}) into ${callerDir}`,
  );

  return {
    alias: meta.alias,
    fingerprint: meta.fingerprint,
    serverKeyFingerprint: meta.serverKeyFingerprint,
    endpointUrl: meta.endpointUrl,
    keysDir: callerDir,
  };
}
