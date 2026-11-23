/**
 * Boot warning for a caller with two connections whose allowlists overlap,
 * path-aware so that scoped templates sharing a host (Calendar and Drive on
 * www.googleapis.com) don't warn.
 */
import { describe, it, expect } from 'vitest';

import {
  allowlistPatternsOverlap,
  connectionOverlapWarnings,
  resolveRoutes,
  type RemoteServerConfig,
} from '../shared/config.js';
import { loadConnection } from '../shared/connections.js';
import { executeProxyRequest, isEndpointAllowed } from './tool-dispatch.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const SLIDES = 'https://slides.googleapis.com/v1/presentations';

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
    expect(
      connectionOverlapWarnings(
        config([
          'google-calendar-readonly',
          'google-drive-readonly',
          'google-gmail-readonly',
          'google-sheets',
        ]),
      ),
    ).toEqual([]);
    expect(
      connectionOverlapWarnings(
        config([
          'google-docs',
          'google-slides',
          'google-sheets',
          'google-drive-readonly',
          'google-drive-file',
        ]),
      ),
    ).toEqual([]);
  });

  it.each([
    ['google-docs', 'google-docs-sa'],
    ['google-slides', 'google-slides-sa'],
    ['google', 'google-docs'],
    ['google', 'google-docs-sa'],
    ['google', 'google-slides'],
    ['google', 'google-slides-sa'],
  ])('warns for %s with %s (Docs/Slides), and says OAuth2 requests are refused', (a, b) => {
    const warnings = connectionOverlapWarnings(config([a, b]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`"${a}" and "${b}"`);
    expect(warnings[0]).toContain('refused (OAuth2)');
  });

  it.each([
    ['google-sheets', 'google-sheets-readonly'],
    ['google-sheets', 'google-sheets-readonly-sa'],
    ['google-sheets', 'google-sheets-sa'],
    ['google', 'google-sheets'],
    ['google', 'google-sheets-sa'],
  ])('warns for %s with %s, and says OAuth2 requests are refused', (a, b) => {
    const warnings = connectionOverlapWarnings(config([a, b]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`"${a}" and "${b}"`);
    expect(warnings[0]).toContain('refused (OAuth2)');
  });
});

describe('google-sheets overlapping another Sheets connection at request time', () => {
  const env = {
    GOOGLE_API_TOKEN: 'static-token',
    GOOGLE_OAUTH_CLIENT_ID: 'cid',
    GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
    GOOGLE_OAUTH_REFRESH_TOKEN: 'rt',
    GOOGLE_SERVICE_ACCOUNT_KEY: 'key',
  };
  const routesFor = (aliases: string[]) =>
    resolveRoutes(
      aliases.map((alias) => ({ ...loadConnection(alias), alias })),
      env,
      'alice',
    );

  it.each([
    ['google-sheets', 'google-sheets-readonly'],
    ['google-sheets-readonly', 'google-sheets'],
    ['google-sheets', 'google-sheets-sa'],
    ['google-sheets', 'google-sheets-readonly-sa'],
    ['google', 'google-sheets'],
    ['google-sheets', 'google'],
  ])('%s + %s: a URL both allow is refused before any token is minted', async (a, b) => {
    for (const [method, url] of [
      ['GET', `${SHEETS}/1AbC`],
      ['PUT', `${SHEETS}/1AbC/values/Sheet1!A1:B2?valueInputOption=RAW`],
      ['POST', `${SHEETS}/1AbC:batchUpdate`],
    ]) {
      await expect(
        executeProxyRequest({ method, url }, routesFor([a, b]), undefined, { caller: 'alice' }),
      ).rejects.toThrow(new RegExp(`Ambiguous endpoint.*"${a}", "${b}"`));
    }
  });

  it('every google-sheets URL is also one google-sheets-readonly allows', () => {
    // So the pair is ambiguous for every request but spreadsheets.create.
    const rw = loadConnection('google-sheets').allowedEndpoints;
    const ro = loadConnection('google-sheets-readonly').allowedEndpoints;
    for (const url of [`${SHEETS}/1AbC`, `${SHEETS}/1AbC/values:batchUpdate`]) {
      expect(isEndpointAllowed(url, rw) && isEndpointAllowed(url, ro), url).toBe(true);
    }
    expect(isEndpointAllowed(SHEETS, rw)).toBe(true);
    expect(isEndpointAllowed(SHEETS, ro)).toBe(false);
  });
});

describe('google-docs and google-slides overlapping another connection at request time', () => {
  const env = {
    GOOGLE_API_TOKEN: 'static-token',
    GOOGLE_OAUTH_CLIENT_ID: 'cid',
    GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
    GOOGLE_OAUTH_REFRESH_TOKEN: 'rt',
    GOOGLE_SERVICE_ACCOUNT_KEY: 'key',
  };
  const routesFor = (aliases: string[]) =>
    resolveRoutes(
      aliases.map((alias) => ({ ...loadConnection(alias), alias })),
      env,
      'alice',
    );

  it('the static google template allowlists both hosts', () => {
    const { allowedEndpoints } = loadConnection('google');
    expect(allowedEndpoints).toContain('https://docs.googleapis.com/**');
    expect(allowedEndpoints).toContain('https://slides.googleapis.com/**');
  });

  const DOCS_URLS: [string, string][] = [
    ['POST', DOCS],
    ['GET', `${DOCS}/1AbC?includeTabsContent=true`],
    ['POST', `${DOCS}/1AbC:batchUpdate`],
  ];
  const SLIDES_URLS: [string, string][] = [
    ['POST', SLIDES],
    ['GET', `${SLIDES}/1AbC`],
    ['POST', `${SLIDES}/1AbC:batchUpdate`],
    ['GET', `${SLIDES}/1AbC/pages/p1`],
    ['GET', `${SLIDES}/1AbC/pages/p1/thumbnail`],
  ];

  it.each([
    ['google-docs', 'google-docs-sa', DOCS_URLS],
    ['google-docs-sa', 'google-docs', DOCS_URLS],
    ['google', 'google-docs', DOCS_URLS],
    ['google-docs', 'google', DOCS_URLS],
    ['google', 'google-docs-sa', DOCS_URLS],
    ['google-slides', 'google-slides-sa', SLIDES_URLS],
    ['google-slides-sa', 'google-slides', SLIDES_URLS],
    ['google', 'google-slides', SLIDES_URLS],
    ['google-slides', 'google', SLIDES_URLS],
    ['google', 'google-slides-sa', SLIDES_URLS],
  ] as const)(
    '%s + %s: every method URL is refused before any token is minted',
    async (a, b, urls) => {
      for (const [method, url] of urls) {
        await expect(
          executeProxyRequest({ method, url }, routesFor([a, b]), undefined, { caller: 'alice' }),
        ).rejects.toThrow(new RegExp(`Ambiguous endpoint.*"${a}", "${b}"`));
      }
    },
  );

  it('google-docs and google-slides on one caller each keep their own URLs', () => {
    const docs = loadConnection('google-docs').allowedEndpoints;
    const slides = loadConnection('google-slides').allowedEndpoints;
    for (const [, url] of DOCS_URLS) expect(isEndpointAllowed(url, slides), url).toBe(false);
    for (const [, url] of SLIDES_URLS) expect(isEndpointAllowed(url, docs), url).toBe(false);
  });
});
