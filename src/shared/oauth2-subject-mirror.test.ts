/**
 * The dashboard's Google editor checks the subject inline with a copy of the
 * daemon's rule (frontend/src/utils/oauth2Subject.ts). It must accept and
 * refuse exactly what the daemon does: never stricter, never looser.
 */
import { describe, it, expect } from 'vitest';

import { isValidOAuth2Subject } from './connections.js';
import { isValidOAuth2Subject as dashboardRule } from '../../frontend/src/utils/oauth2Subject.js';

const CASES: unknown[] = [
  'alice@example.com',
  'alice@localhost',
  'a@b',
  'first.last+tag@sub.example.co.uk',
  '',
  'alice',
  '@example.com',
  'alice@',
  'a@b@c',
  'alice @example.com',
  'alice@exa mple.com',
  'alice@example.com\n',
  'alice\t@example.com',
  'ali\x00ce@example.com',
  'ali\x7fce@example.com',
  `${'a'.repeat(300)}@${'b'.repeat(19)}`,
  `${'a'.repeat(300)}@${'b'.repeat(20)}`,
  'ünïcödé@例え.jp',
  42,
  null,
  undefined,
];

describe('the dashboard subject check mirrors isValidOAuth2Subject', () => {
  it.each(CASES.map((c) => [typeof c === 'string' ? JSON.stringify(c) : String(c), c]))(
    '%s',
    (_label, c) => {
      expect(dashboardRule(c)).toBe(isValidOAuth2Subject(c));
    },
  );

  it('the cases cover both outcomes', () => {
    expect(CASES.some((c) => isValidOAuth2Subject(c))).toBe(true);
    expect(CASES.some((c) => !isValidOAuth2Subject(c))).toBe(true);
  });
});
