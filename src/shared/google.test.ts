/**
 * The `google` selection: validateGoogleSelection() and composeGoogleRoute().
 */
import { describe, it, expect } from 'vitest';

import type { GoogleCallerConfig, Route } from './config.js';
import { validateOAuth2Route } from './connections.js';
import {
  composeGoogleRoute,
  googleConsentScopes,
  googleCredentialRoutes,
  loadGoogleCatalog,
  validateGoogleSelection,
} from './google.js';

const S = 'https://www.googleapis.com/auth/';
const KNOWN = '(known: gmail, calendar, drive, sheets, docs, slides)';

/** The base template's shape (src/connections/productivity/google.json). */
const BASE: Route = {
  name: 'Google',
  stability: 'beta',
  category: 'productivity',
  description: 'base',
  docsUrl: 'https://developers.google.com/workspace',
  secrets: {
    GOOGLE_OAUTH_CLIENT_ID: '${GOOGLE_OAUTH_CLIENT_ID}',
    GOOGLE_OAUTH_CLIENT_SECRET: '${GOOGLE_OAUTH_CLIENT_SECRET}',
    GOOGLE_OAUTH_REFRESH_TOKEN: '${GOOGLE_OAUTH_REFRESH_TOKEN}',
    GOOGLE_SERVICE_ACCOUNT_KEY: '${GOOGLE_SERVICE_ACCOUNT_KEY}',
  },
  composed: 'google',
  allowedEndpoints: [],
};

describe('validateGoogleSelection', () => {
  it.each([
    [
      'not an object',
      'sheets',
      'google must be an object: { "auth": "user" | "service-account", "services": { … } }',
    ],
    [
      'null',
      null,
      'google must be an object: { "auth": "user" | "service-account", "services": { … } }',
    ],
    [
      'an array',
      [],
      'google must be an object: { "auth": "user" | "service-account", "services": { … } }',
    ],
    [
      'an unknown key',
      { auth: 'user', services: { sheets: 'edit' }, scopes: [] },
      'google has unknown field "scopes" (allowed: auth, services, subject)',
    ],
    [
      'auth missing',
      { services: { sheets: 'edit' } },
      'google.auth must be "user" or "service-account"',
    ],
    [
      'auth other',
      { auth: 'oauth', services: { sheets: 'edit' } },
      'google.auth must be "user" or "service-account"',
    ],
    [
      'services missing',
      { auth: 'user' },
      'google.services must name at least one service (gmail, calendar, drive, sheets, docs, slides)',
    ],
    [
      'services not an object',
      { auth: 'user', services: ['sheets'] },
      'google.services must name at least one service (gmail, calendar, drive, sheets, docs, slides)',
    ],
    [
      'services empty',
      { auth: 'user', services: {} },
      'google.services must name at least one service (gmail, calendar, drive, sheets, docs, slides)',
    ],
    [
      'an unknown service',
      { auth: 'user', services: { tasks: 'read' } },
      `google.services: unknown service "tasks" ${KNOWN}. For other Google APIs, define a custom connector: CONNECTIONS.md → Other Google APIs`,
    ],
    ...['full', 'edit', 'write'].map((lvl) => [
      `drive: ${lvl}`,
      { auth: 'user', services: { drive: lvl } },
      `google.services.drive: "${lvl}" is not offered: the drive scope would also make the Sheets read level writable and reach every file. Use "read" or "file", or a custom connector`,
    ]),
    [
      'an unknown level',
      { auth: 'user', services: { sheets: 'admin' } },
      'google.services.sheets: unknown level "admin" (levels: read, edit)',
    ],
    [
      'a non-string level',
      { auth: 'user', services: { sheets: 1 } },
      'google.services.sheets: unknown level 1 (levels: read, edit)',
    ],
    [
      'a level not offered with a service account',
      { auth: 'service-account', services: { drive: 'file' } },
      'google.services.drive: level "file" is not available with auth "service-account" (available: read)',
    ],
    [
      'a level not offered with a service account (gmail metadata)',
      { auth: 'service-account', subject: 'a@example.com', services: { gmail: 'metadata' } },
      'google.services.gmail: level "metadata" is not available with auth "service-account" (available: read)',
    ],
    [
      'subject with auth user',
      { auth: 'user', subject: 'a@example.com', services: { sheets: 'edit' } },
      'google.subject is only used with auth "service-account"',
    ],
    [
      'a subject that is not an email',
      { auth: 'service-account', subject: 'alice', services: { sheets: 'edit' } },
      'google.subject must be an email address',
    ],
    [
      'a non-string subject',
      { auth: 'service-account', subject: 42, services: { sheets: 'edit' } },
      'google.subject must be an email address',
    ],
    [
      'gmail with a service account and no subject',
      { auth: 'service-account', services: { gmail: 'read', sheets: 'edit' } },
      'google.services.gmail needs google.subject with auth "service-account": a service account has no mailbox, so it must act as a Workspace user (domain-wide delegation)',
    ],
  ] as [string, unknown, string][])('rejects %s', (_name, raw, message) => {
    expect(() => validateGoogleSelection(raw)).toThrow(message);
    try {
      validateGoogleSelection(raw);
    } catch (err) {
      expect((err as Error).message).toBe(message);
    }
  });

  it.each(['__proto__', 'constructor', 'hasOwnProperty', 'toString'])(
    'treats the prototype key %s as an unknown service',
    (key) => {
      // JSON.parse makes `__proto__` an own key, as remote.config.json would.
      const raw: unknown = JSON.parse(`{"auth":"user","services":{"${key}":"read"}}`);
      expect(() => validateGoogleSelection(raw)).toThrow(`unknown service "${key}"`);
    },
  );

  it.each(['__proto__', 'constructor', 'toString'])(
    'treats the prototype key %s as an unknown level',
    (key) => {
      const raw: unknown = JSON.parse(`{"auth":"user","services":{"sheets":"${key}"}}`);
      expect(() => validateGoogleSelection(raw)).toThrow(`unknown level "${key}"`);
    },
  );

  it('ignores inherited fields: only own properties count', () => {
    const proto = { auth: 'user', services: { sheets: 'edit' } };
    expect(() => validateGoogleSelection(Object.create(proto))).toThrow(
      'google.auth must be "user" or "service-account"',
    );
  });

  it('accepts a user selection and returns it in catalog order, as a fresh object', () => {
    const raw = { auth: 'user', services: { slides: 'edit', drive: 'read', sheets: 'edit' } };
    const sel = validateGoogleSelection(raw);
    expect(sel).toEqual({
      auth: 'user',
      services: { drive: 'read', sheets: 'edit', slides: 'edit' },
    });
    expect(Object.keys(sel.services)).toEqual(['drive', 'sheets', 'slides']);
    expect(sel).not.toBe(raw);
    expect(sel.services).not.toBe(raw.services);
  });

  it('accepts a service-account selection with a subject, and gmail with one', () => {
    expect(
      validateGoogleSelection({
        auth: 'service-account',
        subject: 'alice@example.com',
        services: { gmail: 'read', calendar: 'read' },
      }),
    ).toEqual({
      auth: 'service-account',
      subject: 'alice@example.com',
      services: { gmail: 'read', calendar: 'read' },
    });
  });

  it('accepts a service-account selection without a subject when no level needs one', () => {
    expect(
      validateGoogleSelection({ auth: 'service-account', services: { sheets: 'edit' } }),
    ).toEqual({ auth: 'service-account', services: { sheets: 'edit' } });
  });

  it('accepts sheets: read with drive: file (documented cross-scope note)', () => {
    expect(() =>
      validateGoogleSelection({ auth: 'user', services: { sheets: 'read', drive: 'file' } }),
    ).not.toThrow();
  });
});

describe('composeGoogleRoute', () => {
  const user: GoogleCallerConfig = {
    auth: 'user',
    services: { sheets: 'edit', docs: 'edit', slides: 'edit', drive: 'read' },
  };
  const sa: GoogleCallerConfig = {
    auth: 'service-account',
    subject: 'alice@example.com',
    services: { gmail: 'read', calendar: 'read' },
  };
  const catalog = loadGoogleCatalog();

  it('composes a user-OAuth route from the selected levels, in catalog order', () => {
    const route = composeGoogleRoute(BASE, user);
    expect(route.oauth2).toEqual({
      tokenUrl: 'https://oauth2.googleapis.com/token',
      grant: 'refresh_token',
      clientAuth: 'body',
      secretRefs: {
        clientId: 'GOOGLE_OAUTH_CLIENT_ID',
        clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
        refreshToken: 'GOOGLE_OAUTH_REFRESH_TOKEN',
      },
      scopes: [S + 'drive.readonly', S + 'spreadsheets', S + 'documents', S + 'presentations'],
    });
    expect(route.secrets).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: '${GOOGLE_OAUTH_CLIENT_ID}',
      GOOGLE_OAUTH_CLIENT_SECRET: '${GOOGLE_OAUTH_CLIENT_SECRET}',
      GOOGLE_OAUTH_REFRESH_TOKEN: '${GOOGLE_OAUTH_REFRESH_TOKEN}',
    });
    expect(route.allowedEndpoints).toEqual([
      ...catalog.services.drive.levels.read.allowedEndpoints,
      ...catalog.services.sheets.levels.edit.allowedEndpoints,
      ...catalog.services.docs.levels.edit.allowedEndpoints,
      ...catalog.services.slides.levels.edit.allowedEndpoints,
    ]);
    expect(route.testConnections?.map((t) => [t.name, t.level])).toEqual([
      ['drive', 'read'],
      ['sheets', 'edit'],
      ['docs', 'edit'],
      ['slides', 'edit'],
    ]);
    expect(route.testConnections?.[0]).toEqual({
      name: 'drive',
      level: 'read',
      ...catalog.services.drive.levels.read.testConnection,
    });
    expect(route.testConnection).toBeUndefined();
    expect(route).toMatchObject({
      alias: 'google',
      name: 'Google',
      category: 'productivity',
      stability: 'beta',
      docsUrl: 'https://developers.google.com/workspace',
    });
    expect(route.composed).toBeUndefined();
    expect(route.headers).toBeUndefined();
    expect(route.description).toMatch(
      /^Google \(user OAuth\): drive read, sheets edit, docs edit, slides edit\. drive read: list, search/,
    );
  });

  it('is deterministic whatever the key order of the selection', () => {
    const reordered: GoogleCallerConfig = {
      auth: 'user',
      services: { drive: 'read', slides: 'edit', docs: 'edit', sheets: 'edit' },
    };
    expect(composeGoogleRoute(BASE, reordered)).toEqual(composeGoogleRoute(BASE, user));
  });

  it('composes a service-account route that carries the subject, not subjectRequired', () => {
    const route = composeGoogleRoute(BASE, sa);
    expect(route.oauth2).toEqual({
      tokenUrl: 'https://oauth2.googleapis.com/token',
      grant: 'jwt_bearer',
      secretRefs: { serviceAccountKey: 'GOOGLE_SERVICE_ACCOUNT_KEY' },
      scopes: [S + 'gmail.readonly', S + 'calendar.readonly'],
      subject: 'alice@example.com',
    });
    expect(route.secrets).toEqual({ GOOGLE_SERVICE_ACCOUNT_KEY: '${GOOGLE_SERVICE_ACCOUNT_KEY}' });
    expect(route.description).toMatch(
      /^Google \(service account, delegated\): gmail read, calendar read\./,
    );
    // Who it acts as is never in the description (list_routes shows it).
    expect(route.description).not.toContain('alice');
    expect(JSON.stringify({ ...route, oauth2: undefined })).not.toContain('alice');
  });

  it('omits subject for a service account without one', () => {
    const route = composeGoogleRoute(BASE, {
      auth: 'service-account',
      services: { sheets: 'edit' },
    });
    expect(route.oauth2).not.toHaveProperty('subject');
    expect(route.description).toMatch(/^Google \(service account\): sheets edit\./);
  });

  it('passes validateOAuth2Route as a connector in both modes', () => {
    expect(() => validateOAuth2Route(composeGoogleRoute(BASE, user), 'connector')).not.toThrow();
    expect(() => validateOAuth2Route(composeGoogleRoute(BASE, sa), 'connector')).not.toThrow();
  });

  it('de-duplicates allowlist patterns and scopes', () => {
    // drive.file and drive.read share no scope, but every level's own list is
    // already duplicate-free; composing two services can't repeat a pattern
    // (disjoint), so the union is the concatenation.
    const route = composeGoogleRoute(BASE, user);
    expect(new Set(route.allowedEndpoints).size).toBe(route.allowedEndpoints.length);
    expect(new Set(route.oauth2?.scopes).size).toBe(route.oauth2?.scopes?.length);
  });

  it('fails if the base template lacks a credential the mode needs', () => {
    const base = { ...BASE, secrets: { GOOGLE_SERVICE_ACCOUNT_KEY: 'x' } };
    expect(() => composeGoogleRoute(base, user)).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });

  it('googleConsentScopes is the sorted union', () => {
    expect(googleConsentScopes(user)).toEqual([
      S + 'documents',
      S + 'drive.readonly',
      S + 'presentations',
      S + 'spreadsheets',
    ]);
  });

  it('googleCredentialRoutes gives one composed route per auth mode', () => {
    const routes = googleCredentialRoutes(BASE);
    expect(routes.map((r) => r.oauth2?.grant).sort()).toEqual(['jwt_bearer', 'refresh_token']);
    const names = routes.flatMap((r) => Object.keys(r.secrets ?? {})).sort();
    expect(names).toEqual([
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'GOOGLE_OAUTH_REFRESH_TOKEN',
      'GOOGLE_SERVICE_ACCOUNT_KEY',
    ]);
  });
});
