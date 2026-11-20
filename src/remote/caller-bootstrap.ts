/**
 * Caller provisioning — drawlatch is the sole issuer of caller key material.
 *
 * One primitive, two delivery modes (see plans/caller-credential-issuance.md):
 *   - `issueCallerBundle()` — mint a keypair IN MEMORY, persist only the public
 *     half, and return the credential bundle (download via the admin API, or the
 *     `drawlatch issue-caller` CLI). The caller PRIVATE key never touches
 *     drawlatch disk; it lives only inside the returned bundle.
 *   - `issueLocalCaller()` — same primitive, but write the UNPACKED key files
 *     straight into a co-located callboard's keys dir over the shared filesystem.
 *     The same-host write IS the trust proof (replaces the old enroll-token dance).
 *
 * `createCallerWithKeys()` (priv+pub on drawlatch disk) is retained for the
 * password-gated `POST /api/admin/callers` create endpoint and tests.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  loadRemoteConfig,
  saveRemoteConfig,
  getCallerKeysDir,
  type RemoteServerConfig,
  type CallerConfig,
} from '../shared/config.js';
import {
  createCaller,
  exportServerPublicKeys,
  serverFingerprint,
  saveCallerPublicKeys,
} from '../shared/crypto/key-manager.js';
import {
  generateKeyBundle,
  serializeKeyBundle,
  extractPublicKeys,
  serializePublicKeys,
  fingerprint,
  type SerializedPublicKeys,
} from '../shared/crypto/keys.js';
import type { CallerBundleV1, BundleEncryption } from '../shared/protocol/caller-bundle.js';
import {
  generateBundleSalt,
  deriveBundleKey,
  encryptBundleField,
  DEFAULT_SCRYPT_PARAMS,
} from '../shared/protocol/caller-bundle-crypto.js';
import { setEnvVars } from '../shared/env-utils.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('caller-bootstrap');

/** Valid caller alias: starts with a letter/number, then letters/numbers/-/_. */
export const CALLER_ALIAS_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export interface CreateCallerOptions {
  /** Human-readable display name (defaults to the alias). */
  name?: string;
  /** Connection aliases to grant. When omitted, clones the `default` caller's
   *  connections so a new caller starts with the same access (common expectation). */
  connections?: string[];
}

export interface CreateCallerResult {
  alias: string;
  name: string;
  fingerprint: string;
  /** The caller's freshly-generated public keys (private keys stay on disk). */
  publicKeys: SerializedPublicKeys;
  /** Directory holding the caller's keypair (keys/callers/<alias>/). */
  keysDir: string;
  connections: string[];
}

function assertValidAlias(alias: string): void {
  if (!CALLER_ALIAS_REGEX.test(alias)) {
    throw new Error(
      'Invalid alias: must start with a letter or number and contain only ' +
        'letters, numbers, hyphens, and underscores',
    );
  }
}

/** Clone the `default` caller's connections (the new-caller default access). */
function defaultConnections(config: RemoteServerConfig): string[] {
  const defaultCaller = config.callers.default as CallerConfig | undefined;
  return [...(defaultCaller?.connections ?? [])];
}

/**
 * Create a caller WITH a fresh keypair on drawlatch disk (priv+pub), registered
 * in remote.config.json. Used by the dashboard "New caller" action.
 *
 * Throws on invalid alias, or if the caller (config entry or key dir) exists.
 */
export function createCallerWithKeys(
  alias: string,
  opts: CreateCallerOptions = {},
): CreateCallerResult {
  assertValidAlias(alias);

  const config = loadRemoteConfig();
  if (alias in config.callers || callerKeyDirExists(alias)) {
    throw new Error(`Caller "${alias}" already exists`);
  }

  // Generate the caller's keypair under keys/callers/<alias>/.
  const { publicKeys, fingerprint: fp } = createCaller(alias);

  const name = opts.name ?? alias;
  const connections = opts.connections ?? defaultConnections(config);

  // New callers start locked: their agent can't enable connections or set
  // secrets for itself. The operator flips it in the dashboard if wanted.
  config.callers[alias] = { name, connections, selfManage: false };
  saveRemoteConfig(config);

  log.info(
    `Created caller "${alias}" with keypair (${connections.length} connection(s), fingerprint ${fp})`,
  );

  return {
    alias,
    name,
    fingerprint: fp,
    publicKeys,
    keysDir: path.join(getCallerKeysDir(), alias),
    connections,
  };
}

/** Whether a caller key directory already holds key material. */
function callerKeyDirExists(alias: string): boolean {
  const dir = path.join(getCallerKeysDir(), alias);
  return (
    fs.existsSync(path.join(dir, 'signing.pub.pem')) ||
    fs.existsSync(path.join(dir, 'signing.key.pem'))
  );
}

// ── Issuance primitive ──────────────────────────────────────────────────────

export interface IssueCallerOptions {
  alias: string;
  /** Human-readable display name (preserved on re-issue; defaults to alias). */
  name?: string;
  /** Connections to authorize. Preserved on re-issue; clones `default` for new. */
  connections?: string[];
  /** drawlatch endpoint this caller identity is scoped to (pinned in the bundle). */
  endpointUrl: string;
  /** When set, `caller.*.priv` is scrypt+AES-256-GCM wrapped in the bundle. */
  passphrase?: string;
  /** ISO timestamp override (tests). Defaults to now. */
  createdAt?: string;
}

/**
 * Issue (or re-issue / rotate) a caller credential bundle.
 *
 *   1. Generate the Ed25519 + X25519 keypair IN MEMORY.
 *   2. Register/update the caller in remote.config.json (connections, name,
 *      source='bundle-issued').
 *   3. Persist ONLY the public keys to keys/callers/<alias>/ (the private key
 *      never touches drawlatch disk).
 *   4. Assemble the v1 bundle (caller priv+pub, server pub-only, endpoint,
 *      fingerprints, connections), optionally passphrase-wrapping the two
 *      private PEMs.
 *   5. Zero the derived key material from memory and return the bundle.
 *
 * Re-issuing an existing caller mints a FRESH keypair and overwrites the stored
 * public key — invalidating the prior credential (the old private key can no
 * longer authenticate). The bundle is returned once; drawlatch keeps no copy of
 * the private material, so it is unrecoverable afterward.
 */
export function issueCallerBundle(opts: IssueCallerOptions): CallerBundleV1 {
  const { alias, endpointUrl, passphrase } = opts;
  assertValidAlias(alias);
  if (typeof endpointUrl !== 'string' || endpointUrl.trim() === '') {
    throw new Error('endpointUrl is required');
  }

  const config = loadRemoteConfig();
  const existing = config.callers[alias] as CallerConfig | undefined;

  // Mint the keypair in memory and serialize before any disk writes.
  const bundleKeys = generateKeyBundle();
  const serialized = serializeKeyBundle(bundleKeys);
  const publicKeys = serializePublicKeys(extractPublicKeys(bundleKeys));
  const callerFp = fingerprint(extractPublicKeys(bundleKeys));

  // Resolve name + connections (preserve existing values on re-issue).
  const name = opts.name ?? existing?.name ?? alias;
  const connections = opts.connections ?? existing?.connections ?? defaultConnections(config);

  // Register/update the caller, preserving any unrelated fields (env, overrides…).
  config.callers[alias] = {
    // New callers start locked (selfManage: false); a re-issue keeps whatever
    // the existing entry has, including an absent (permissive) flag.
    ...(existing ?? { selfManage: false }),
    name,
    connections,
    source: 'bundle-issued',
  };
  saveRemoteConfig(config);

  // Persist ONLY the public keys (drops any stale private files from a prior mint).
  saveCallerPublicKeys(alias, publicKeys);

  const serverPub = exportServerPublicKeys();
  const serverFp = serverFingerprint();

  // Optionally passphrase-wrap the two private PEMs. The derived key is zeroed
  // immediately after use; the plaintext PEMs are only referenced transiently.
  let encryption: BundleEncryption | null = null;
  let callerSigningPriv = serialized.signing.privateKey;
  let callerExchangePriv = serialized.exchange.privateKey;
  if (passphrase !== undefined && passphrase !== '') {
    encryption = {
      kdf: 'scrypt',
      salt: generateBundleSalt(),
      ...DEFAULT_SCRYPT_PARAMS,
      alg: 'aes-256-gcm',
    };
    const key = deriveBundleKey(passphrase, encryption);
    callerSigningPriv = encryptBundleField(serialized.signing.privateKey, key);
    callerExchangePriv = encryptBundleField(serialized.exchange.privateKey, key);
    key.fill(0);
  }

  const bundle: CallerBundleV1 = {
    version: 1,
    callerAlias: alias,
    fingerprint: callerFp,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    expiresAt: null,
    endpointUrl,
    serverKeyFingerprint: serverFp,
    connections,
    caller: {
      signing: { priv: callerSigningPriv, pub: serialized.signing.publicKey },
      exchange: { priv: callerExchangePriv, pub: serialized.exchange.publicKey },
    },
    server: {
      signing: { pub: serverPub.signing },
      exchange: { pub: serverPub.exchange },
    },
    encryption,
  };

  // Best-effort: drop our references to the in-memory private material. (JS
  // strings can't be explicitly zeroed; the guarantee that matters — the private
  // key is never written to drawlatch disk — is enforced above.)
  callerSigningPriv = '';
  callerExchangePriv = '';

  log.info(
    `Issued caller "${alias}" (${connections.length} connection(s), fingerprint ${callerFp}` +
      `${encryption ? ', passphrase-wrapped' : ''}${existing ? ', re-issue' : ''})`,
  );

  return bundle;
}

// ── Local mode (auto-share to a co-located callboard) ───────────────────────

export interface IssueLocalCallerOptions {
  /** Caller alias (default 'callboard-local'). */
  alias?: string;
  /** Human-readable display name. */
  name?: string;
  /** Connections to authorize (defaults to cloning `default`). */
  connections?: string[];
  /** callboard's keys dir (the directory that holds `callers/` and `server/`). */
  keysDir: string;
}

export interface IssueLocalCallerResult {
  alias: string;
  fingerprint: string;
  /** The caller key directory written inside callboard's keys dir. */
  callerKeysDir: string;
  connections: string[];
}

/**
 * Issue a caller and write the UNPACKED key files straight into a co-located
 * callboard's keys dir over the shared filesystem (same-host write is the trust
 * proof). drawlatch keeps only the public key; callboard gets the private key on
 * its own disk — bit-for-bit the steady state of the old pairing flow, with no
 * token dance.
 *
 * Writes, under `<keysDir>`:
 *   - callers/<alias>/{signing,exchange}.{key,pub}.pem  (0600 / 0644)
 *   - server/{signing,exchange}.pub.pem                 (0644)
 */
export function issueLocalCaller(opts: IssueLocalCallerOptions): IssueLocalCallerResult {
  const alias = opts.alias ?? 'callboard-local';
  assertValidAlias(alias);

  const config = loadRemoteConfig();
  const existing = config.callers[alias] as CallerConfig | undefined;

  const bundleKeys = generateKeyBundle();
  const serialized = serializeKeyBundle(bundleKeys);
  const publicKeys = serializePublicKeys(extractPublicKeys(bundleKeys));
  const callerFp = fingerprint(extractPublicKeys(bundleKeys));

  const connections = opts.connections ?? existing?.connections ?? defaultConnections(config);
  const name = opts.name ?? existing?.name ?? alias;

  config.callers[alias] = {
    // New callers start locked; an existing entry keeps its own setting.
    ...(existing ?? { selfManage: false }),
    name,
    connections,
    source: 'local-auto',
  };
  saveRemoteConfig(config);

  // drawlatch keeps only the public half.
  saveCallerPublicKeys(alias, publicKeys);

  // Write the unpacked key files into callboard's keys dir.
  const callerKeysDir = path.join(opts.keysDir, 'callers', alias);
  fs.mkdirSync(callerKeysDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(callerKeysDir, 'signing.pub.pem'), serialized.signing.publicKey, {
    mode: 0o644,
  });
  fs.writeFileSync(path.join(callerKeysDir, 'exchange.pub.pem'), serialized.exchange.publicKey, {
    mode: 0o644,
  });
  fs.writeFileSync(path.join(callerKeysDir, 'signing.key.pem'), serialized.signing.privateKey, {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(callerKeysDir, 'exchange.key.pem'), serialized.exchange.privateKey, {
    mode: 0o600,
  });

  // And the server's public keys so callboard can pin the server identity.
  const serverPub = exportServerPublicKeys();
  const serverDir = path.join(opts.keysDir, 'server');
  fs.mkdirSync(serverDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(serverDir, 'signing.pub.pem'), serverPub.signing, { mode: 0o644 });
  fs.writeFileSync(path.join(serverDir, 'exchange.pub.pem'), serverPub.exchange, { mode: 0o644 });

  log.info(
    `Auto-shared local caller "${alias}" to ${callerKeysDir} ` +
      `(${connections.length} connection(s), fingerprint ${callerFp})`,
  );

  return { alias, fingerprint: callerFp, callerKeysDir, connections };
}

/**
 * First-boot hook: when drawlatch is supervised by a co-located callboard (which
 * sets DRAWLATCH_LOCAL_CALLER_KEYS_DIR to its own keys dir), auto-share a default
 * caller into that dir — but only once (skipped if the caller already exists).
 *
 * Replaces the retired enroll-token / `/sync/auto-enroll` path.
 */
export function maybeIssueLocalCaller(): IssueLocalCallerResult | null {
  const keysDir = process.env.DRAWLATCH_LOCAL_CALLER_KEYS_DIR;
  if (!keysDir) return null;

  const alias = process.env.DRAWLATCH_LOCAL_CALLER_ALIAS ?? 'callboard-local';
  const config = loadRemoteConfig();
  if (alias in config.callers && callerKeyDirExists(alias)) {
    // Already provisioned on a prior boot — nothing to do.
    return null;
  }

  const connectionsEnv = process.env.DRAWLATCH_LOCAL_CALLER_CONNECTIONS;
  const connections = connectionsEnv
    ? connectionsEnv
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    : undefined;

  try {
    return issueLocalCaller({ alias, keysDir, ...(connections && { connections }) });
  } catch (err) {
    log.error(`Could not auto-share local caller "${alias}":`, err);
    return null;
  }
}

// ── Delete ──────────────────────────────────────────────────────────────────

/**
 * Delete a caller: removes its config entry, prefixed env vars, and key dir.
 * The `default` caller cannot be deleted.
 */
export function deleteCaller(alias: string): void {
  if (alias === 'default') {
    throw new Error('Cannot delete the "default" caller');
  }

  const config = loadRemoteConfig();
  if (!(alias in config.callers)) {
    throw new Error(`Caller "${alias}" not found`);
  }

  // Clean up prefixed env vars referenced by this caller's env mapping.
  const caller = config.callers[alias];
  if (caller.env) {
    const envUpdates: Record<string, string> = {};
    for (const mapping of Object.values(caller.env)) {
      const envMatch = /^\$\{(.+)\}$/.exec(mapping);
      if (envMatch) envUpdates[envMatch[1]] = ''; // empty string = delete
    }
    if (Object.keys(envUpdates).length > 0) setEnvVars(envUpdates);
  }

  const { [alias]: _removed, ...remainingCallers } = config.callers;
  config.callers = remainingCallers;
  saveRemoteConfig(config);

  // Remove the caller's key directory.
  const keysDir = path.join(getCallerKeysDir(), alias);
  if (fs.existsSync(keysDir)) {
    fs.rmSync(keysDir, { recursive: true, force: true });
  }

  log.info(`Deleted caller "${alias}"`);
}

/** Re-exported for callers that want to introspect config without re-importing. */
export type { RemoteServerConfig };
