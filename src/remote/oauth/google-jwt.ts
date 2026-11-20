/**
 * Google service-account keys and the RS256 JWT assertion for the
 * `jwt_bearer` grant (RFC 7523, Google's "OAuth 2.0 for Server to Server
 * Applications").
 *
 * Secret-boundary invariants:
 *   - The private key is only ever handed to node:crypto. It never reaches a
 *     header, a log line, or an error message.
 *   - Every parse failure throws the same fixed message. Parser errors
 *     (JSON.parse, createPrivateKey) can quote their input, so they are never
 *     passed through.
 *   - The key file's `token_uri` is ignored: the assertion's `aud`, and the
 *     endpoint it is sent to, are always the route's `tokenUrl`.
 */

import crypto from 'node:crypto';

/** The fields drawlatch reads from a Google service-account key file. */
export interface GoogleServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

/** A parsed key plus its imported signing key. */
export interface ParsedServiceAccountKey extends GoogleServiceAccountKey {
  signingKey: crypto.KeyObject;
}

/** The only message a key-parse failure ever carries. */
export const INVALID_SERVICE_ACCOUNT_KEY_MESSAGE =
  'not a valid Google service-account key (expected base64 of the JSON key file, or the JSON itself)';

export class ServiceAccountKeyError extends Error {
  constructor() {
    super(INVALID_SERVICE_ACCOUNT_KEY_MESSAGE);
    this.name = 'ServiceAccountKeyError';
  }
}

/** Lifetime of an assertion, and so the longest Google allows (1 hour). */
export const JWT_ASSERTION_LIFETIME_SEC = 3600;

/** The `grant_type` for an assertion grant (RFC 7523 §2.1). */
export const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/**
 * Escape raw CR/LF inside JSON string literals. A key that went through a
 * `.env` file double-quoted can come back with its `\n` escapes expanded into
 * real newlines, which JSON.parse rejects inside a string. Newlines between
 * tokens are left alone.
 */
function escapeNewlinesInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      } else if (ch === '\n') {
        out += '\\n';
        continue;
      } else if (ch === '\r') {
        continue;
      }
    } else if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  return out;
}

/** The JSON text of a key given as base64 or as raw JSON, or undefined. */
function keyJsonText(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  // base64 or base64url, possibly wrapped (`base64` without -w0).
  const compact = trimmed.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return undefined;
  const decoded = Buffer.from(compact, 'base64').toString('utf8').trim();
  return decoded.startsWith('{') ? decoded : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  for (const candidate of [text, escapeNewlinesInStrings(text)]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return undefined;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/**
 * Parse a service-account key secret. Accepts base64 of the JSON key file
 * (the documented form: no quotes or newlines to survive a `.env` file) or the
 * JSON itself, tolerating newlines that a `.env` round trip expanded and a
 * private key whose `\n` escapes were doubled.
 *
 * @throws ServiceAccountKeyError, always with the same fixed message.
 */
export function parseServiceAccountKey(raw: string): ParsedServiceAccountKey {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64 * 1024) {
    throw new ServiceAccountKeyError();
  }
  const text = keyJsonText(raw);
  const data = text === undefined ? undefined : parseJsonObject(text);
  if (!data) throw new ServiceAccountKeyError();

  const { client_email: clientEmail, private_key_id: keyId, type } = data;
  const rawPrivateKey = data.private_key;
  if (type !== undefined && type !== 'service_account') throw new ServiceAccountKeyError();
  if (typeof clientEmail !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(clientEmail)) {
    throw new ServiceAccountKeyError();
  }
  if (keyId !== undefined && (typeof keyId !== 'string' || !/^[\w-]{1,256}$/.test(keyId))) {
    throw new ServiceAccountKeyError();
  }
  if (typeof rawPrivateKey !== 'string' || rawPrivateKey.length === 0) {
    throw new ServiceAccountKeyError();
  }
  let privateKey = rawPrivateKey;
  // Doubled escapes: the PEM arrives with literal backslash-n separators.
  if (!privateKey.includes('\n') && privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\r\\n|\\n/g, '\n');
  }
  privateKey = privateKey.replace(/\r\n/g, '\n');

  let signingKey: crypto.KeyObject;
  try {
    signingKey = crypto.createPrivateKey({ key: privateKey, format: 'pem' });
  } catch {
    throw new ServiceAccountKeyError();
  }
  if (signingKey.asymmetricKeyType !== 'rsa') throw new ServiceAccountKeyError();

  return {
    client_email: clientEmail,
    private_key: privateKey,
    ...(keyId !== undefined && { private_key_id: keyId }),
    signingKey,
  };
}

/**
 * Fingerprint of a key's identity for the token cache: changes when the
 * account, key ID, or key material changes. Never contains the key itself.
 */
export function serviceAccountKeyFingerprint(key: GoogleServiceAccountKey): string {
  const keyHash = crypto.createHash('sha256').update(key.private_key).digest('hex');
  return crypto
    .createHash('sha256')
    .update(`jwt_bearer\0${key.client_email}\0${key.private_key_id ?? ''}\0${keyHash}`)
    .digest('hex');
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

export interface JwtAssertionClaims {
  /** Space-separated scopes. */
  scope: string;
  /** The token endpoint (the route's `tokenUrl`). */
  aud: string;
  /** Delegated user (domain-wide delegation), when set. */
  sub?: string;
  /** Issue time, epoch seconds. */
  nowSec: number;
}

/**
 * Build and sign an RS256 assertion:
 *   header `{alg: RS256, typ: JWT, kid?}`,
 *   claims `{iss: client_email, scope, aud, iat, exp: iat + 3600, sub?}`.
 */
export function signJwtAssertion(
  key: Pick<ParsedServiceAccountKey, 'client_email' | 'private_key_id'> & {
    signingKey: crypto.KeyObject;
  },
  claims: JwtAssertionClaims,
): string {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    ...(key.private_key_id !== undefined && { kid: key.private_key_id }),
  };
  const iat = Math.floor(claims.nowSec);
  const payload = {
    iss: key.client_email,
    scope: claims.scope,
    aud: claims.aud,
    iat,
    exp: iat + JWT_ASSERTION_LIFETIME_SEC,
    ...(claims.sub !== undefined && { sub: claims.sub }),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), key.signingKey);
  return `${signingInput}.${base64url(signature)}`;
}
