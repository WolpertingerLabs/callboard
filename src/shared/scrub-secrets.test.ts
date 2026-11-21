/**
 * compileSecretScrubber / scrubSecretsDeep compile the secret forms once per
 * scrub. Their output must match scrubbing each string independently with
 * scrubSecrets() (the pre-compilation behaviour).
 */
import { describe, it, expect } from 'vitest';

import {
  compileSecretScrubber,
  scrubSecrets,
  scrubSecretsDeep,
  secretWireForms,
  MIN_SCRUBBED_SECRET_LENGTH,
} from './config.js';

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
 * non-ASCII header value read back as bytes comes out as Latin-1. Only forms
 * that encode the *whole* value count: never a piece of it.
 */
describe('wire forms', () => {
  const PLAIN = `nasty-'|a b"c%+dé\\h/i`;
  const QMARK = `x-'|a b"c%+dé\\h/i?j`;
  const scrub = compileSecretScrubber({ V: PLAIN, W: QMARK });

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
      ['V', PLAIN],
      ['W', QMARK],
    ]) {
      const wire = form(v);
      expect(wire).not.toBe(v); // the form really differs from the raw value
      expect(scrub(`echo: <${wire}>`)).toBe(`echo: <\${${name}}>`);
    }
  });

  /** WHATWG percent-decoding over UTF-8 bytes; a stray `%` stays as it is. */
  const pct = (text: string, plusIsSpace = false): string => {
    const b = Buffer.from(plusIsSpace ? text.replace(/\+/g, ' ') : text, 'utf8');
    const out: number[] = [];
    for (let i = 0; i < b.length; i++) {
      const hex = String.fromCharCode(b[i + 1] ?? 0, b[i + 2] ?? 0);
      if (b[i] === 0x25 && /^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else out.push(b[i]);
    }
    return Buffer.from(out).toString('utf8');
  };
  /** Ways to read a form back: JSON-unescaped, Latin-1 bytes as UTF-8, percent-decoded. */
  const readings = (form: string): string[] => {
    const json: string[] = [form];
    try {
      json.push(JSON.parse(`"${form}"`) as string);
    } catch {
      // Not a JSON-escaped form.
    }
    return json
      .flatMap((x) => [x, Buffer.from(x, 'latin1').toString('utf8')])
      .flatMap((x) => [x, pct(x), pct(x, true)]);
  };
  /** The whole value, and the whole value as a URL path or a server decodes it. */
  const wholeValue = (v: string): string[] =>
    [v, v.replace(/^[^?]*/, (path) => path.replace(/\\/g, '/'))].flatMap((x) => [
      x,
      pct(x),
      pct(x, true),
    ]);

  it('every form is at least the floor long and encodes or decodes the whole value', () => {
    // A decoded form can be shorter than the value (`%41%41%41%41` → `AAAA`),
    // but it is still the whole value, never a piece of it.
    const values = [
      PLAIN,
      QMARK,
      'Summer#2024!xyz',
      'status?Xk29vLq',
      'a/../bcdefgh',
      'tok ',
      'a\tbcdef',
      '%41%41%41%41',
      'x%2Fy%2Fz',
      'ab%41cd',
      '100%+off now',
      'é%C3%A9 x',
    ];
    for (const v of values) {
      const whole = new Set(wholeValue(v));
      for (const form of secretWireForms(v)) {
        expect(form.length).toBeGreaterThanOrEqual(MIN_SCRUBBED_SECRET_LENGTH);
        expect(readings(form).some((r) => whole.has(r))).toBe(true);
      }
    }
    // The decoded form really is there, and scrubbed.
    expect(secretWireForms('%41%41%41%41')).toContain('AAAA');
    expect(compileSecretScrubber({ S: '%41%41%41%41' })('the word AAAA')).toBe('the word ${S}');
  });

  it('a plain value has one form, so plain values cost nothing extra', () => {
    const s = compileSecretScrubber({ P: 'plain-Value_123' });
    expect(s('x plain-Value_123 y')).toBe('x ${P} y');
  });
});

/**
 * Review B2: pieces of a value (the part before a `#`, either side of a `?`,
 * what's left after URL dot-segment collapsing, a trailing space the URL
 * parser trims) are never scrubbed on their own. They corrupt ordinary text
 * and would let an agent confirm a secret piece by piece.
 */
describe('pieces of a value are never scrubbed', () => {
  const PIECES = {
    BOT_PASSWORD: 'status?Xk29vLq',
    API_SECRET: 'Summer#2024!xyz',
    DOTTED: 'a/../bcdefgh',
    TRAILING: 'trailing-space ',
  };
  const DATA = { status: 'open', items: [{ name: 'Summer sale' }], note: 'bcdefgh trailing-space' };

  it('leaves ordinary JSON and text unchanged', () => {
    expect(scrubSecretsDeep(DATA, PIECES)).toEqual(DATA);
    const text = JSON.stringify({ status: 'open', items: [{ name: 'Summer sale' }] });
    expect(text).toBe('{"status":"open","items":[{"name":"Summer sale"}]}');
    expect(scrubSecrets(text, PIECES)).toBe(text);
    expect(scrubSecrets('Xk29vLq 2024!xyz bcdefgh', PIECES)).toBe('Xk29vLq 2024!xyz bcdefgh');
  });

  it('still scrubs the whole values, raw and encoded', () => {
    expect(scrubSecrets(`a ${PIECES.API_SECRET} b`, PIECES)).toBe('a ${API_SECRET} b');
    expect(scrubSecrets(`a ${encodeURIComponent(PIECES.BOT_PASSWORD)} b`, PIECES)).toBe(
      'a ${BOT_PASSWORD} b',
    );
  });

  it('secretWireForms returns no piece', () => {
    expect(secretWireForms('Summer#2024!xyz')).not.toContain('Summer');
    expect(secretWireForms('status?Xk29vLq')).not.toContain('status');
    expect(secretWireForms('status?Xk29vLq')).not.toContain('Xk29vLq');
    expect(secretWireForms('a/../bcdefgh')).not.toContain('bcdefgh');
    expect(secretWireForms('trailing-space ')).not.toContain('trailing-space');
  });
});
