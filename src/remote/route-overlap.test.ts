/**
 * Boot warning for a caller with two connections whose allowlists overlap,
 * path-aware so that scoped templates sharing a host (Calendar and Drive on
 * www.googleapis.com) don't warn.
 */
import { describe, it, expect } from 'vitest';

import {
  allowlistPatternsOverlap,
  connectionOverlapWarnings,
  type RemoteServerConfig,
} from '../shared/config.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';

describe('allowlistPatternsOverlap', () => {
  it.each([
    ['https://www.googleapis.com/**', `${DRIVE}/files**`, true],
    [`${DRIVE}/files**`, `${DRIVE}/files**`, true],
    [`${DRIVE}/files**`, `${CAL}/freeBusy`, false],
    [`${CAL}/freeBusy`, `${CAL}/calendars/*`, false],
    [`${CAL}/freeBusy`, `${CAL}/freeBusy`, true],
    [`${GMAIL}/messages/*`, `${GMAIL}/messages/*/attachments/*`, true],
    [`${GMAIL}/profile`, `${GMAIL}/profile?**`, false],
    [`${GMAIL}/profile`, `${GMAIL}/**`, true],
    ['https://a.example.com/**', 'https://b.example.com/**', false],
    ['https://*.example.com/**', 'https://b.example.com/x', true],
    ['http://a.example.com/**', 'https://a.example.com/**', false],
    ['**', 'https://a.example.com/x', true],
  ])('%s vs %s → %s', (a, b, expected) => {
    expect(allowlistPatternsOverlap(a, b)).toBe(expected);
    expect(allowlistPatternsOverlap(b, a)).toBe(expected);
  });
});

describe('connectionOverlapWarnings', () => {
  const config = (connections: string[]): RemoteServerConfig =>
    ({
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      callers: { alice: { connections } },
    }) as RemoteServerConfig;

  it('warns when the static google template shadows a scoped one', () => {
    const [warning, ...rest] = connectionOverlapWarnings(
      config(['google', 'google-drive-readonly']),
    );
    expect(rest).toEqual([]);
    expect(warning).toContain('Caller "alice"');
    expect(warning).toContain('"google" and "google-drive-readonly"');
    expect(warning).toContain('"https://www.googleapis.com/**"');
    expect(warning).toContain('refused (OAuth2)');
  });

  it('warns for two scoped templates of one service', () => {
    expect(
      connectionOverlapWarnings(config(['google-gmail-metadata', 'google-gmail-readonly'])),
    ).toHaveLength(1);
    expect(
      connectionOverlapWarnings(config(['google-drive-readonly', 'google-drive-readonly-sa'])),
    ).toHaveLength(1);
  });

  it('is quiet for scoped templates of different services on one host', () => {
    expect(
      connectionOverlapWarnings(
        config([
          'google-calendar-readonly',
          'google-drive-readonly',
          'google-gmail-readonly',
          'google-sheets-readonly',
          'github',
        ]),
      ),
    ).toEqual([]);
  });
});
