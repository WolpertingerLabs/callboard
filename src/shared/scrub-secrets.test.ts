/**
 * compileSecretScrubber / scrubSecretsDeep compile the secret forms once per
 * scrub. Their output must match scrubbing each string independently with
 * scrubSecrets() (the pre-compilation behaviour).
 */
import { describe, it, expect } from 'vitest';

import { compileSecretScrubber, scrubSecrets, scrubSecretsDeep } from './config.js';

const SECRETS = {
  OUTER: 'tok-OUTER-VALUE',
  INNER: 'tok-OUT', // a prefix of OUTER: longest-first ordering matters
  SLASHY: 'a/b"c\\d+e=f',
  SHORT: 'ab', // below the 4-char floor: never scrubbed
  UNICODE: 'tøken-ü/1',
};

/** Reference: per-string scrubSecrets, the behaviour before compilation. */
function naiveDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubSecrets(value, SECRETS);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 64) return scrubSecrets(JSON.stringify(value), SECRETS);
  if (Array.isArray(value)) return value.map((v) => naiveDeep(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      scrubSecrets(k, SECRETS),
      naiveDeep(v, depth + 1),
    ]),
  );
}

/** Deterministic pseudo-random strings mixing every secret form. */
function corpus(): string[] {
  const pieces = [
    ...Object.values(SECRETS),
    ...Object.values(SECRETS).map(encodeURIComponent),
    ...Object.values(SECRETS).map((v) => JSON.stringify(v).slice(1, -1)),
    ...Object.values(SECRETS).map((v) => JSON.stringify(v).slice(1, -1).replace(/\//g, '\\/')),
    'plain',
    ' ',
    'tok-',
    '"',
    '/',
    '',
  ];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  return Array.from({ length: 500 }, () =>
    Array.from({ length: next() % 8 }, () => pieces[next() % pieces.length]).join(''),
  );
}

describe('compiled secret scrubbing', () => {
  it('compileSecretScrubber matches scrubSecrets on every string', () => {
    const scrub = compileSecretScrubber(SECRETS);
    for (const text of corpus()) expect(scrub(text)).toBe(scrubSecrets(text, SECRETS));
  });

  it('scrubSecretsDeep matches per-string scrubbing for a large tree, keys included', () => {
    const strings = corpus();
    const tree = {
      list: strings,
      byKey: Object.fromEntries(strings.map((s, i) => [`${s}#${i}`, { v: s, n: i, b: true }])),
      nested: strings.slice(0, 20).reduce<unknown>((acc, s) => ({ [s]: acc, s }), null),
    };
    expect(scrubSecretsDeep(tree, SECRETS)).toEqual(naiveDeep(tree));
    // A precompiled scrubber gives the same result.
    expect(scrubSecretsDeep(tree, compileSecretScrubber(SECRETS))).toEqual(naiveDeep(tree));
  });

  it('matches past the depth limit too', () => {
    let deep: unknown = SECRETS.OUTER;
    for (let i = 0; i < 80; i++) deep = { [`k${SECRETS.INNER}`]: deep };
    expect(scrubSecretsDeep(deep, SECRETS)).toEqual(naiveDeep(deep));
  });

  it('is the identity when nothing is long enough to scrub', () => {
    const scrub = compileSecretScrubber({ A: 'ab', B: '' });
    expect(scrub('ab and more ab')).toBe('ab and more ab');
  });
});
