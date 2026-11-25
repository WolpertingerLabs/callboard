/**
 * Caller credential bundle (v1) — the format authority, types only.
 *
 * This module has NO runtime imports so it can be re-exported into type-only
 * consumers (e.g. the dashboard via `admin-types.ts`) without dragging in
 * node:crypto. The wrap/unwrap helpers live in `caller-bundle-crypto.ts`.
 *
 * Both drawlatch (the issuer) and callboard (the importer) depend on these types
 * so the wire shape stays in lock-step.
 *
 * Security model (see plans/caller-credential-issuance.md):
 *   - The bundle carries the caller's PRIVATE keys — this is intentional. The
 *     keypair is a capability drawlatch mints to grant access to itself (the AWS
 *     IAM access-key model), shown once.
 *   - It carries only the server's PUBLIC keys (so callboard can pin the server
 *     identity and derive session keys).
 *   - It NEVER carries connection-secret values. `connections` is a name list
 *     only — authorization is resolved server-side per request.
 *   - When a passphrase is supplied, ONLY `caller.signing.priv` and
 *     `caller.exchange.priv` are ciphertext; everything else stays plaintext so
 *     callboard can show alias/fingerprint/endpoint before asking for it.
 */

/** How a caller's keys came to exist, surfaced as a badge in the dashboard. */
export type CallerSource = 'local-auto' | 'bundle-issued';

/** Passphrase-wrap metadata recorded in the bundle so callboard can decrypt. */
export interface BundleEncryption {
  kdf: 'scrypt';
  /** base64-encoded scrypt salt. */
  salt: string;
  /** scrypt cost parameter N (CPU/memory). */
  n: number;
  /** scrypt block-size parameter r. */
  r: number;
  /** scrypt parallelization parameter p. */
  p: number;
  /** AEAD cipher used for the wrapped private keys. */
  alg: 'aes-256-gcm';
}

/** A single keypair half — `priv` is omitted from the server side. */
export interface BundleKeyPair {
  /** PEM (plaintext) or, when `encryption != null`, the wrapped ciphertext. */
  priv: string;
  pub: string;
}

/** The `{alias}.drawlatch-caller.json` v1 document. */
export interface CallerBundleV1 {
  version: 1;
  callerAlias: string;
  /** SHA-256 fingerprint of the caller public keys (display / verify). */
  fingerprint: string;
  createdAt: string;
  expiresAt: string | null;
  /** drawlatch endpoint this caller identity is scoped to (pinned). */
  endpointUrl: string;
  /** Fingerprint of the server public keys so callboard can confirm the pin. */
  serverKeyFingerprint: string;
  /** Informational — authorization lives server-side, not in the bundle. */
  connections: string[];
  caller: {
    signing: BundleKeyPair;
    exchange: BundleKeyPair;
  };
  /** Public-only — verify drawlatch + derive session keys. */
  server: {
    signing: { pub: string };
    exchange: { pub: string };
  };
  /** null when the private keys are plaintext; metadata when passphrase-wrapped. */
  encryption: BundleEncryption | null;
}
