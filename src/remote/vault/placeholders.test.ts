import { describe, it, expect, vi } from 'vitest';

import {
  assertVaultNotInOrigin,
  hasVaultToken,
  parseVaultSpec,
  substitutePlaceholders,
  vaultSpecs,
} from './placeholders.js';

describe('parseVaultSpec', () => {
  it.each([
    ['tok', { name: 'tok', field: 'value', explicitField: false }],
    ['tok.username', { name: 'tok', field: 'username', explicitField: true }],
    ['alice/tok', { owner: 'alice', name: 'tok', field: 'value', explicitField: false }],
    ['alice/tok.api_key', { owner: 'alice', name: 'tok', field: 'api_key', explicitField: true }],
    ['my-item_2', { name: 'my-item_2', field: 'value', explicitField: false }],
  ])('parses %s', (spec, ref) => {
    expect(parseVaultSpec(spec)).toEqual(ref);
  });

  it.each([
    '',
    '.value',
    'tok.',
    '/tok',
    'a/b/c',
    'a.b.c',
    'tok:x',
    'tok value',
    '-tok',
    'tok.1field',
    '${X}',
    'constructor',
    'tok.__proto__',
    '__proto__/tok',
    'x'.repeat(65),
  ])('refuses %j', (spec) => {
    expect(parseVaultSpec(spec)).toBeUndefined();
  });
});

describe('token scanning', () => {
  it('finds vault tokens, including empty and malformed ones', () => {
    expect(vaultSpecs('a ${vault:x} ${X} ${vault:y.z} ${vault:} ${vault:a.b.c}')).toEqual([
      'x',
      'y.z',
      '',
      'a.b.c',
    ]);
    expect(hasVaultToken('${vault:x}')).toBe(true);
    expect(hasVaultToken('${X} ${vault:unclosed')).toBe(false);
  });
});

describe('substitutePlaceholders', () => {
  const secrets = { A: 'alpha', B: 'pre-${vault:x}-post' };
  const vault = new Map([['x', 'val-${A}']]);

  it('resolves both kinds in one pass over the original string', () => {
    expect(substitutePlaceholders('${A}|${vault:x}|${B}', secrets, vault)).toBe(
      'alpha|val-${A}|pre-${vault:x}-post',
    );
  });

  it('leaves an unknown ${VAR} literal, with the usual warning', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(substitutePlaceholders('${NOPE}${vault:x}', secrets, vault)).toBe('${NOPE}val-${A}');
      expect(spy).toHaveBeenCalledWith(
        '[config] Warning: placeholder ${NOPE} not found in secrets',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('JSON-escapes vault values on request', () => {
    const v = new Map([['q', 'a"b\\c\n']]);
    expect(substitutePlaceholders('{"k":"${vault:q}"}', {}, v, { jsonEscape: true })).toBe(
      '{"k":"a\\"b\\\\c\\n"}',
    );
  });

  it('never interprets $ patterns in a value', () => {
    const v = new Map([['d', "$& $' $1"]]);
    expect(substitutePlaceholders('${vault:d}', {}, v)).toBe("$& $' $1");
  });
});

describe('assertVaultNotInOrigin', () => {
  it.each([
    'https://${vault:x}/a',
    'https://api.example.com:${vault:x}/a',
    'https://${vault:x}@api.example.com/a',
    '${vault:x}://api.example.com/a',
    'https:${vault:x}/a',
    'https:\\\\${vault:x}/a',
    '/relative/${vault:x}',
  ])('refuses %s', (url) => {
    expect(() => assertVaultNotInOrigin(url)).toThrow("a vault placeholder can't choose the host");
  });

  it.each([
    'https://api.example.com/${vault:x}',
    'https://api.example.com?q=${vault:x}',
    'https://api.example.com#${vault:x}',
    'https://api.example.com/a\\${vault:x}',
  ])('allows %s', (url) => {
    expect(() => assertVaultNotInOrigin(url)).not.toThrow();
  });
});
