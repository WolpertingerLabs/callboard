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

/**
 * Every form a value takes on the wire, produced by the real encoders: a
 * value substituted into a URL is sent as the WHATWG serializer writes it,
 * an upstream that parses a query as a form decodes `+` to a space, and a
 * non-ASCII header value read back as bytes comes out as Latin-1.
 */
describe('wire forms', () => {
  const NASTY = `nasty-'|a b"c%+dé\\h/i?j#k`;
  const NOTHASH = `x-'|a b"c%+dé\\h/i?j`;
  const scrub = compileSecretScrubber({ V: NASTY, W: NOTHASH });

  const pathForm = (v: string) => {
    const u = new URL(`http://h/p/${v}`);
    return u.pathname.slice('/p/'.length) + u.search;
  };
  const queryForm = (v: string) => new URL(`http://h/?q=${v}`).search.slice('?q='.length);
  const formForm = (v: string) => new URLSearchParams([['q', v]]).toString().slice('q='.length);

  it.each([
    ['path', pathForm],
    ['query', queryForm],
    ['form-urlencoded', formForm],
    ['form-decoded query', (v: string) => new URLSearchParams(`q=${queryForm(v)}`).get('q')!],
    ['UTF-8 bytes read as Latin-1', (v: string) => Buffer.from(v, 'utf8').toString('latin1')],
    ['JSON-escaped path', (v: string) => JSON.stringify(pathForm(v)).slice(1, -1)],
    ['JSON-escaped query', (v: string) => JSON.stringify(queryForm(v)).slice(1, -1)],
  ])('scrubs the %s form', (_k, form) => {
    for (const [name, v] of [
      ['V', NASTY],
      ['W', NOTHASH],
    ]) {
      const wire = form(v);
      expect(wire).not.toBe(v); // the form really differs from the raw value
      expect(scrub(`echo: <${wire}>`)).toBe(`echo: <\${${name}}>`);
    }
  });

  it('a fragment cuts the value where the URL parser does', () => {
    // The part before `#` is what was sent; it is scrubbed as a whole.
    expect(queryForm(NASTY)).not.toContain('k');
    expect(scrub(`/x?q=${queryForm(NASTY)}`)).toBe('/x?q=${V}');
  });

  it('adds no form shorter than the floor', () => {
    // `ab#cdef` is sent as `ab`: too short to scrub without shredding text.
    const s = compileSecretScrubber({ S: 'ab#cdef' });
    expect(s('ab ab#cdef')).toBe('ab ${S}');
  });

  it('a plain value has one form, so plain values cost nothing extra', () => {
    const s = compileSecretScrubber({ P: 'plain-Value_123' });
    expect(s('x plain-Value_123 y')).toBe('x ${P} y');
  });
});
