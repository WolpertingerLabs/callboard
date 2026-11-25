/**
 * Boot warning for a caller with two connections whose allowlists overlap,
 * path-aware so that services sharing a host (Calendar and Drive on
 * www.googleapis.com, both inside the composed `google` route) don't warn,
 * and the request-time refusal when an OAuth2 connection is among them.
 */
import { describe, it, expect } from 'vitest';

import {
  allowlistPatternsOverlap,
  connectionOverlapWarnings,
  resolveCallerRoutesChecked,
  resolveRoutes,
  type GoogleCallerConfig,
  type RemoteServerConfig,
  type Route,
} from '../shared/config.js';
import { executeProxyRequest } from './tool-dispatch.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

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
  const ALL: GoogleCallerConfig = {
    auth: 'user',
    services: {
      gmail: 'read',
      calendar: 'read',
      drive: 'read',
      sheets: 'edit',
      docs: 'edit',
      slides: 'edit',
    },
  };
  /** A custom connector on Drive paths the composed route also allows. */
  const DRIVE_CONNECTOR: Route = {
    alias: 'my-drive',
    headers: { Authorization: 'Bearer ${MY_DRIVE_TOKEN}' },
    secrets: { MY_DRIVE_TOKEN: '${MY_DRIVE_TOKEN}' },
    allowedEndpoints: [`${DRIVE}/**`],
  };
  const config = (
    connections: string[],
    google?: GoogleCallerConfig,
    connectors?: Route[],
  ): RemoteServerConfig =>
    ({
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      ...(connectors && { connectors }),
      callers: { alice: { connections, ...(google && { google }) } },
    }) as RemoteServerConfig;

  it('is quiet for google alone, every service selected (Calendar and Drive share a host)', () => {
    expect(connectionOverlapWarnings(config(['google'], ALL))).toEqual([]);
    expect(connectionOverlapWarnings(config(['google', 'github'], ALL))).toEqual([]);
  });

  it('warns for google next to a custom connector on a Drive path, and says requests are refused', () => {
    const warnings = connectionOverlapWarnings(
      config(['google', 'my-drive'], { auth: 'user', services: { drive: 'read' } }, [
        DRIVE_CONNECTOR,
      ]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Caller "alice"');
    expect(warnings[0]).toContain('"google" and "my-drive"');
    expect(warnings[0]).toContain('refused (OAuth2)');
  });

  it('is quiet when the custom connector misses every selected service', () => {
    expect(
      connectionOverlapWarnings(
        config(['google', 'my-drive'], { auth: 'user', services: { sheets: 'edit' } }, [
          DRIVE_CONNECTOR,
        ]),
      ),
    ).toEqual([]);
  });

  it('warns for two static connections on one host without saying they are refused', () => {
    const [warning, ...rest] = connectionOverlapWarnings(config(['discord-bot', 'discord-oauth']));
    expect(rest).toEqual([]);
    expect(warning).toContain('"discord-bot" and "discord-oauth"');
    expect(warning).not.toContain('refused');
  });
});

describe('google overlapping a custom connector at request time', () => {
  const DRIVE_CONNECTOR: Route = {
    alias: 'my-drive',
    headers: { Authorization: 'Bearer ${MY_DRIVE_TOKEN}' },
    secrets: { MY_DRIVE_TOKEN: '${MY_DRIVE_TOKEN}' },
    allowedEndpoints: [`${DRIVE}/**`, `${SHEETS}/**`],
  };
  const routesFor = (connections: string[]) => {
    const config = {
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      connectors: [DRIVE_CONNECTOR],
      callers: {
        alice: {
          connections,
          google: { auth: 'user', services: { drive: 'read', sheets: 'edit' } },
        },
      },
    } as RemoteServerConfig;
    const { routes, problems } = resolveCallerRoutesChecked(config, 'alice');
    expect(problems).toEqual([]);
    return resolveRoutes(
      routes,
      {
        MY_DRIVE_TOKEN: 'static-token',
        GOOGLE_OAUTH_CLIENT_ID: 'cid',
        GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
        GOOGLE_OAUTH_REFRESH_TOKEN: 'rt',
      },
      'alice',
    );
  };

  it.each([[['google', 'my-drive']], [['my-drive', 'google']]])(
    '%j: a URL both allow is refused before any token is minted',
    async (connections) => {
      for (const [method, url] of [
        ['GET', `${DRIVE}/files`],
        ['GET', `${DRIVE}/about?fields=user`],
        ['GET', `${SHEETS}/1AbC`],
        ['POST', `${SHEETS}/1AbC:batchUpdate`],
      ]) {
        await expect(
          executeProxyRequest({ method, url }, routesFor(connections), undefined, {
            caller: 'alice',
          }),
        ).rejects.toThrow(
          new RegExp(`Ambiguous endpoint.*"${connections[0]}", "${connections[1]}"`),
        );
      }
    },
  );
});
