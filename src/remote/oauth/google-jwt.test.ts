/**
 * Google service-account key parsing and RS256 assertion signing.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

import {
  INVALID_SERVICE_ACCOUNT_KEY_MESSAGE,
  JWT_ASSERTION_LIFETIME_SEC,
  parseServiceAccountKey,
  serviceAccountKeyFingerprint,
  signJwtAssertion,
} from './google-jwt.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

function keyFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'service_account',
    project_id: 'proj',
    private_key_id: 'kid-0123456789abcdef',
    private_key: PEM,
    client_email: 'robot@proj.iam.gserviceaccount.com',
    client_id: '1234567890',
    token_uri: 'https://evil.example.com/token',
    ...overrides,
  };
}

const json = (o: unknown, indent?: number) => JSON.stringify(o, null, indent);
const b64 = (s: string) => Buffer.from(s).toString('base64');

function decodeJwt(jwt: string) {
  const [h, p, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>,
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

describe('parseServiceAccountKey', () => {
  it.each([
    ['base64 of the JSON key file', b64(json(keyFile(), 2))],
    ['base64 wrapped at 76 columns', b64(json(keyFile(), 2)).replace(/(.{76})/g, '$1\n')],
    ['base64url', Buffer.from(json(keyFile())).toString('base64url')],
    ['raw JSON', json(keyFile())],
    ['pretty-printed raw JSON', json(keyFile(), 2)],
    ['raw JSON with surrounding whitespace', `  \n${json(keyFile())}\n `],
  ])('accepts %s', (_label, raw) => {
    const key = parseServiceAccountKey(raw);
    expect(key.client_email).toBe('robot@proj.iam.gserviceaccount.com');
    expect(key.private_key_id).toBe('kid-0123456789abcdef');
    expect(key.private_key).toBe(PEM);
    expect(key.signingKey.asymmetricKeyType).toBe('rsa');
  });

  it('accepts JSON whose \\n escapes a .env round trip expanded into real newlines', () => {
    // dotenv expands \n inside double quotes: the PEM's escapes become real
    // newlines inside a JSON string, which JSON.parse alone rejects.
    const expanded = json(keyFile()).replace(/\\n/g, '\n');
    expect(() => JSON.parse(expanded) as unknown).toThrow();
    expect(parseServiceAccountKey(expanded).private_key).toBe(PEM);
    // …also with pretty-printing newlines between the fields.
    const prettyExpanded = json(keyFile(), 2).replace(/\\n/g, '\n');
    expect(parseServiceAccountKey(prettyExpanded).private_key).toBe(PEM);
  });

  it('accepts a private key whose newlines were double-escaped', () => {
    const doubled = json(keyFile({ private_key: PEM.replace(/\n/g, '\\n') }));
    expect(parseServiceAccountKey(doubled).private_key).toBe(PEM);
  });

  it('accepts a key without private_key_id or type', () => {
    const key = parseServiceAccountKey(
      json(keyFile({ private_key_id: undefined, type: undefined })),
    );
    expect(key.private_key_id).toBeUndefined();
  });

  const SENTINEL = 'sentinel-input-9f8e7d';
  it.each([
    ['empty', ''],
    ['not JSON or base64', `not a key ${SENTINEL}`],
    ['base64 of something else', b64(`hello ${SENTINEL}`)],
    ['JSON array', json([SENTINEL])],
    ['truncated JSON', json(keyFile()).slice(0, 80) + SENTINEL],
    ['wrong type', json(keyFile({ type: 'authorized_user', client_secret: SENTINEL }))],
    ['missing client_email', json(keyFile({ client_email: undefined, x: SENTINEL }))],
    ['bad client_email', json(keyFile({ client_email: SENTINEL }))],
    ['missing private_key', json(keyFile({ private_key: undefined, x: SENTINEL }))],
    [
      'garbage private_key',
      json(keyFile({ private_key: `-----BEGIN PRIVATE KEY-----\n${SENTINEL}` })),
    ],
    [
      'non-RSA key',
      json(
        keyFile({
          private_key: crypto
            .generateKeyPairSync('ec', { namedCurve: 'P-256' })
            .privateKey.export({ type: 'pkcs8', format: 'pem' }),
          x: SENTINEL,
        }),
      ),
    ],
    ['bad private_key_id', json(keyFile({ private_key_id: `${SENTINEL} "quoted"` }))],
    ['oversized', 'A'.repeat(70 * 1024) + SENTINEL],
  ])('rejects %s with the fixed message, never echoing input', (_label, raw) => {
    let message = '';
    try {
      parseServiceAccountKey(raw);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(INVALID_SERVICE_ACCOUNT_KEY_MESSAGE);
    expect(message).not.toContain(SENTINEL);
    expect(message).not.toContain('PRIVATE KEY');
  });
});

describe('signJwtAssertion', () => {
  const key = parseServiceAccountKey(b64(json(keyFile())));
  const AUD = 'https://oauth2.googleapis.com/token';

  it('signs RS256 and verifies with the public key', () => {
    const jwt = signJwtAssertion(key, { scope: 'a b', aud: AUD, nowSec: 1_700_000_000.9 });
    const { header, payload, signingInput, signature } = decodeJwt(jwt);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-0123456789abcdef' });
    expect(crypto.verify('RSA-SHA256', Buffer.from(signingInput), publicKey, signature)).toBe(true);
    expect(payload).toEqual({
      iss: 'robot@proj.iam.gserviceaccount.com',
      scope: 'a b',
      aud: AUD,
      iat: 1_700_000_000,
      exp: 1_700_000_000 + JWT_ASSERTION_LIFETIME_SEC,
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
  });

  it('uses the given aud, never the key file token_uri', () => {
    const { payload } = decodeJwt(signJwtAssertion(key, { scope: 's', aud: AUD, nowSec: 1 }));
    expect(payload.aud).toBe(AUD);
    expect(JSON.stringify(payload)).not.toContain('evil.example.com');
  });

  it('sets sub only when given', () => {
    const without = decodeJwt(signJwtAssertion(key, { scope: 's', aud: AUD, nowSec: 1 }));
    expect('sub' in without.payload).toBe(false);
    const withSub = decodeJwt(
      signJwtAssertion(key, { scope: 's', aud: AUD, sub: 'ceo@example.com', nowSec: 1 }),
    );
    expect(withSub.payload.sub).toBe('ceo@example.com');
  });

  it('omits kid when the key has no private_key_id', () => {
    const noKid = parseServiceAccountKey(json(keyFile({ private_key_id: undefined })));
    const { header } = decodeJwt(signJwtAssertion(noKid, { scope: 's', aud: AUD, nowSec: 1 }));
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('never puts key material in the assertion', () => {
    const jwt = signJwtAssertion(key, { scope: 's', aud: AUD, nowSec: 1 });
    const decoded = JSON.stringify(decodeJwt(jwt).header) + JSON.stringify(decodeJwt(jwt).payload);
    expect(decoded).not.toContain('PRIVATE KEY');
    expect(jwt).not.toContain(PEM.split('\n')[1]);
  });
});

describe('serviceAccountKeyFingerprint', () => {
  const base = parseServiceAccountKey(json(keyFile()));
  const other = crypto
    .generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' });

  it('is stable for the same key and never contains it', () => {
    const fp = serviceAccountKeyFingerprint(base);
    expect(fp).toBe(serviceAccountKeyFingerprint(parseServiceAccountKey(b64(json(keyFile())))));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['client_email', { client_email: 'other@proj.iam.gserviceaccount.com' }],
    ['private_key_id', { private_key_id: 'kid-other' }],
    ['private_key', { private_key: other }],
  ])('changes with %s', (_label, patch) => {
    const changed = parseServiceAccountKey(json(keyFile(patch)));
    expect(serviceAccountKeyFingerprint(changed)).not.toBe(serviceAccountKeyFingerprint(base));
  });
});
