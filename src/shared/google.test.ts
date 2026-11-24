/**
 * The `google` selection: validateGoogleSelection() and composeGoogleRoute().
 */
import { describe, it, expect } from 'vitest';

import {
  resolveCallerRoutesChecked,
  resolveRoutes,
  validateRemoteConfig,
  type GoogleCallerConfig,
  type RemoteServerConfig,
  type Route,
} from './config.js';
import {
  REMOVED_CONNECTIONS,
  callerOptionalSecrets,
  callerRequiredSecrets,
  describeConnectionTemplate,
  listAvailableConnections,
  loadConnection,
  removedConnectionMessage,
  validateOAuth2Route,
} from './connections.js';
import {
  composeGoogleRoute,
  googleBootNotes,
  googleCrossScopeNotes,
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

describe('resolveCallerRoutesChecked with the google connection', () => {
  const config = (callers: RemoteServerConfig['callers'], connectors?: Route[]) =>
    ({
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      ...(connectors && { connectors }),
      callers,
    }) as RemoteServerConfig;

  it('the base template matches nothing and carries no credentials in headers', () => {
    const base = loadConnection('google');
    expect(base.composed).toBe('google');
    expect(base.allowedEndpoints).toEqual([]);
    expect(base.headers).toBeUndefined();
    expect(base.oauth2).toBeUndefined();
    expect(base.testConnection).toBeUndefined();
    expect(Object.keys(base.secrets ?? {}).sort()).toEqual([
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'GOOGLE_OAUTH_REFRESH_TOKEN',
      'GOOGLE_SERVICE_ACCOUNT_KEY',
    ]);
    // Even resolved as-is (composition skipped by mistake), it reaches nothing.
    const [resolved] = resolveRoutes([{ ...base, alias: 'google' }], {}, 'x');
    expect(resolved.allowedEndpoints).toEqual([]);
    expect(resolved.headers).toEqual({});
  });

  it('composes the route for a user-mode caller', () => {
    const { routes, problems } = resolveCallerRoutesChecked(
      config({
        a: {
          connections: ['github', 'google'],
          google: { auth: 'user', services: { sheets: 'edit', drive: 'read' } },
        },
      }),
      'a',
    );
    expect(problems).toEqual([]);
    const google = routes.find((r) => r.alias === 'google');
    expect(google?.oauth2?.grant).toBe('refresh_token');
    expect(google?.oauth2?.scopes).toEqual([S + 'drive.readonly', S + 'spreadsheets']);
    expect(google?.composed).toBeUndefined();
    expect(google?.testConnections).toHaveLength(2);
  });

  it('composes the route for a service-account caller, subject included', () => {
    const { routes, problems } = resolveCallerRoutesChecked(
      config({
        a: {
          connections: ['google'],
          google: {
            auth: 'service-account',
            subject: 'alice@example.com',
            services: { gmail: 'read' },
          },
        },
      }),
      'a',
    );
    expect(problems).toEqual([]);
    expect(routes[0].oauth2).toMatchObject({
      grant: 'jwt_bearer',
      subject: 'alice@example.com',
      scopes: [S + 'gmail.readonly'],
    });
  });

  it('drops google without a block, and names the static template when GOOGLE_API_TOKEN is set', () => {
    const cfg = config({
      a: { connections: ['github', 'google'] },
      b: { connections: ['google'], env: { GOOGLE_API_TOKEN: 'ya29.static' } },
    });
    const a = resolveCallerRoutesChecked(cfg, 'a');
    expect(a.routes.map((r) => r.alias)).toEqual(['github']);
    expect(a.dropped.google).toBe(
      'connection "google" needs callers.a.google = { "auth": "user" | "service-account", "services": { … } } (CONNECTIONS.md → Google)',
    );
    expect(a.problems).toEqual([`Caller "a": connection "google" dropped: ${a.dropped.google}`]);
    const b = resolveCallerRoutesChecked(cfg, 'b');
    expect(b.dropped.google).toBe(
      'connection "google" needs callers.b.google = { "auth": "user" | "service-account", "services": { … } } (CONNECTIONS.md → Google). The static-token "google" template that read GOOGLE_API_TOKEN was removed.',
    );
  });

  it('checks GOOGLE_API_TOKEN by prefixed env var too', () => {
    process.env.PREFIXED_GOOGLE_API_TOKEN = 'ya29.static';
    try {
      const { dropped } = resolveCallerRoutesChecked(
        config({ prefixed: { connections: ['google'] } }),
        'prefixed',
      );
      expect(dropped.google).toContain('GOOGLE_API_TOKEN was removed');
    } finally {
      delete process.env.PREFIXED_GOOGLE_API_TOKEN;
    }
  });

  it('drops google with the validator message when the block is invalid', () => {
    const { routes, dropped } = resolveCallerRoutesChecked(
      config({
        a: {
          connections: ['github', 'google'],
          google: { auth: 'user', services: { drive: 'full' } } as never,
        },
      }),
      'a',
    );
    expect(routes.map((r) => r.alias)).toEqual(['github']);
    expect(dropped.google).toMatch(/^google\.services\.drive: "full" is not offered/);
  });

  it('keeps but ignores a selection when google is not enabled, and says so', () => {
    const { routes, problems, dropped } = resolveCallerRoutesChecked(
      config({
        a: { connections: ['github'], google: { auth: 'user', services: { sheets: 'edit' } } },
      }),
      'a',
    );
    expect(routes.map((r) => r.alias)).toEqual(['github']);
    expect(dropped).toEqual({});
    expect(problems).toEqual([
      'Caller "a": google selection is set but the "google" connection is not enabled; ignored.',
    ]);
  });

  it('drops google when oauth2Overrides["google"] is set', () => {
    const { routes, dropped } = resolveCallerRoutesChecked(
      config({
        a: {
          connections: ['google'],
          google: { auth: 'service-account', services: { sheets: 'edit' } },
          oauth2Overrides: { google: { subject: 'alice@example.com' } },
        },
      }),
      'a',
    );
    expect(routes).toEqual([]);
    expect(dropped.google).toBe(
      'oauth2Overrides["google"] is not used: choose services in callers.a.google, and set the service-account user in google.subject',
    );
  });

  it('lets a custom connector named google win, ignoring the selection with a note', () => {
    const custom: Route = {
      alias: 'google',
      headers: { Authorization: 'Bearer ${MY_TOKEN}' },
      secrets: { MY_TOKEN: '${MY_TOKEN}' },
      allowedEndpoints: ['https://tasks.googleapis.com/tasks/v1/**'],
    };
    const { routes, problems } = resolveCallerRoutesChecked(
      config(
        {
          a: { connections: ['google'], google: { auth: 'user', services: { sheets: 'edit' } } },
          b: { connections: ['google'] },
        },
        [custom],
      ),
      'a',
    );
    expect(routes).toEqual([custom]);
    expect(problems).toEqual([
      'Caller "a": a custom connector named "google" replaces the built-in one; callers.a.google is ignored.',
    ]);
  });

  it('refuses composed on a custom connector', () => {
    const custom: Route = { alias: 'mine', composed: 'google', allowedEndpoints: [] };
    const { routes, dropped } = resolveCallerRoutesChecked(
      config({ a: { connections: ['mine'] } }, [custom]),
      'a',
    );
    expect(routes).toEqual([]);
    expect(dropped.mine).toBe('composed is only allowed on built-in templates');
  });

  it('resolves only the selected mode’s secrets, from prefixed env vars', () => {
    process.env.HH_GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.HH_GOOGLE_OAUTH_CLIENT_SECRET = 'cs';
    process.env.HH_GOOGLE_OAUTH_REFRESH_TOKEN = 'rt';
    process.env.HH_GOOGLE_SERVICE_ACCOUNT_KEY = 'key';
    try {
      const { routes } = resolveCallerRoutesChecked(
        config({
          hh: { connections: ['google'], google: { auth: 'user', services: { docs: 'edit' } } },
        }),
        'hh',
      );
      const [resolved] = resolveRoutes(routes, {}, 'hh');
      expect(resolved.secrets).toEqual({
        GOOGLE_OAUTH_CLIENT_ID: 'cid',
        GOOGLE_OAUTH_CLIENT_SECRET: 'cs',
        GOOGLE_OAUTH_REFRESH_TOKEN: 'rt',
      });
      expect(resolved.withheldSecrets.sort()).toEqual([
        'GOOGLE_OAUTH_CLIENT_ID',
        'GOOGLE_OAUTH_CLIENT_SECRET',
        'GOOGLE_OAUTH_REFRESH_TOKEN',
      ]);
      expect(resolved.oauth2?.effectiveScopes).toEqual([S + 'documents']);
      expect(resolved.testConnections?.map((t) => t.name)).toEqual(['docs']);
    } finally {
      for (const k of Object.keys(process.env)) {
        if (k.startsWith('HH_')) Reflect.deleteProperty(process.env, k);
      }
    }
  });

  it('describeConnectionTemplate marks google as composed, without a fixed auth block', () => {
    const info = describeConnectionTemplate('google', loadConnection('google'));
    expect(info).toMatchObject({
      alias: 'google',
      stability: 'beta',
      composed: 'google',
      requiredSecrets: [
        'GOOGLE_OAUTH_CLIENT_ID',
        'GOOGLE_OAUTH_CLIENT_SECRET',
        'GOOGLE_OAUTH_REFRESH_TOKEN',
      ],
      optionalSecrets: ['GOOGLE_SERVICE_ACCOUNT_KEY'],
      hasTestConnection: true,
    });
    expect(info.auth).toBeUndefined();
  });

  it('googleCredentialRoutes reads the shipped base template by default', () => {
    expect(googleCredentialRoutes()).toEqual(googleCredentialRoutes(loadConnection('google')));
  });
});

describe('REMOVED_CONNECTIONS', () => {
  it('lists the 17 per-scope templates, each naming a catalog level and mode', () => {
    expect(Object.keys(REMOVED_CONNECTIONS)).toHaveLength(17);
    const catalog = loadGoogleCatalog();
    for (const [id, { service, level, auth }] of Object.entries(REMOVED_CONNECTIONS)) {
      expect(id.startsWith('google-'), id).toBe(true);
      expect(auth, id).toBe(id.endsWith('-sa') ? 'service-account' : 'user');
      const l = catalog.services[service].levels[level];
      expect(l, id).toBeDefined();
      expect(l.auth, id).toContain(auth);
    }
  });

  it('formats one line per removed ID, with the caller alias when given', () => {
    expect(removedConnectionMessage('google-sheets')).toBe(
      'Connection "google-sheets" was removed: use "google" with callers.<alias>.google.services.sheets = "edit" (auth "user"). See CONNECTIONS.md → Google.',
    );
    expect(removedConnectionMessage('google-gmail-readonly-sa', 'mail')).toBe(
      'Connection "google-gmail-readonly-sa" was removed: use "google" with callers.mail.google.services.gmail = "read" (auth "service-account"). See CONNECTIONS.md → Google.',
    );
    expect(removedConnectionMessage('github')).toBeUndefined();
    expect(removedConnectionMessage('__proto__')).toBeUndefined();
  });
});

describe('removed connection IDs', () => {
  const USER_IDS: [string, string, string][] = [
    ['google-gmail-metadata', 'gmail', 'metadata'],
    ['google-gmail-readonly', 'gmail', 'read'],
    ['google-calendar-freebusy', 'calendar', 'freebusy'],
    ['google-calendar-readonly', 'calendar', 'read'],
    ['google-drive-file', 'drive', 'file'],
    ['google-drive-readonly', 'drive', 'read'],
    ['google-sheets-readonly', 'sheets', 'read'],
    ['google-sheets', 'sheets', 'edit'],
    ['google-docs', 'docs', 'edit'],
    ['google-slides', 'slides', 'edit'],
  ];
  const SA_IDS: [string, string, string][] = [
    ['google-gmail-readonly-sa', 'gmail', 'read'],
    ['google-calendar-readonly-sa', 'calendar', 'read'],
    ['google-drive-readonly-sa', 'drive', 'read'],
    ['google-sheets-readonly-sa', 'sheets', 'read'],
    ['google-sheets-sa', 'sheets', 'edit'],
    ['google-docs-sa', 'docs', 'edit'],
    ['google-slides-sa', 'slides', 'edit'],
  ];

  it('lists exactly the 17 removed templates, each naming a catalog level', () => {
    expect(Object.keys(REMOVED_CONNECTIONS).sort()).toEqual(
      [...USER_IDS, ...SA_IDS].map(([id]) => id).sort(),
    );
    const catalog = loadGoogleCatalog();
    for (const [id, { service, level, auth }] of Object.entries(REMOVED_CONNECTIONS)) {
      const l = catalog.services[service].levels[level];
      expect(l, id).toBeDefined();
      expect(l.auth, id).toContain(auth);
    }
  });

  it.each(USER_IDS)('loadConnection("%s") says what replaces it (user)', (id, svc, level) => {
    expect(() => loadConnection(id)).toThrow(
      new Error(
        `Connection "${id}" was removed: use "google" with callers.<alias>.google.services.${svc} = "${level}" (auth "user"). See CONNECTIONS.md → Google.`,
      ),
    );
  });

  it.each(SA_IDS)(
    'loadConnection("%s") says what replaces it (service account)',
    (id, svc, level) => {
      expect(() => loadConnection(id)).toThrow(
        new Error(
          `Connection "${id}" was removed: use "google" with callers.<alias>.google.services.${svc} = "${level}" (auth "service-account"). See CONNECTIONS.md → Google.`,
        ),
      );
    },
  );

  it('is not listed as a template', () => {
    const available = listAvailableConnections();
    for (const id of Object.keys(REMOVED_CONNECTIONS)) expect(available).not.toContain(id);
  });

  it('a removed ID drops only that connection for the caller', () => {
    const config = {
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      callers: {
        household: {
          connections: ['github', 'google-sheets', 'google-drive-readonly-sa', 'google'],
          google: { auth: 'user', services: { docs: 'edit' } },
        },
      },
    } as RemoteServerConfig;
    const { routes, problems, dropped } = resolveCallerRoutesChecked(config, 'household');
    expect(routes.map((r) => r.alias)).toEqual(['github', 'google']);
    expect(dropped).toEqual({
      'google-sheets':
        'Connection "google-sheets" was removed: use "google" with callers.household.google.services.sheets = "edit" (auth "user"). See CONNECTIONS.md → Google.',
      'google-drive-readonly-sa':
        'Connection "google-drive-readonly-sa" was removed: use "google" with callers.household.google.services.drive = "read" (auth "service-account"). See CONNECTIONS.md → Google.',
    });
    expect(problems).toEqual([
      `Caller "household": connection "google-sheets" dropped: ${dropped['google-sheets']}`,
      `Caller "household": connection "google-drive-readonly-sa" dropped: ${dropped['google-drive-readonly-sa']}`,
    ]);
    // validateRemoteConfig (boot) reports the same lines.
    expect(validateRemoteConfig(config)).toEqual(problems);
  });

  it('a custom connector may still reuse a removed alias', () => {
    const custom: Route = {
      alias: 'google-sheets',
      headers: { Authorization: 'Bearer ${T}' },
      secrets: { T: 't' },
      allowedEndpoints: ['https://example.com/**'],
    };
    const { routes, dropped } = resolveCallerRoutesChecked(
      {
        host: '127.0.0.1',
        port: 0,
        rateLimitPerMinute: 60,
        connectors: [custom],
        callers: { a: { connections: ['google-sheets'] } },
      } as RemoteServerConfig,
      'a',
    );
    expect(dropped).toEqual({});
    expect(routes).toEqual([custom]);
  });

  it('an unknown ID still fails resolution for the whole caller (unchanged)', () => {
    const config = {
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      callers: { a: { connections: ['github', 'google-sheetz'] } },
    } as RemoteServerConfig;
    expect(() => resolveCallerRoutesChecked(config, 'a')).toThrow(
      /^Unknown connection "google-sheetz"/,
    );
    expect(validateRemoteConfig(config)).toEqual([
      expect.stringMatching(/^Caller "a": Unknown connection "google-sheetz"/),
    ]);
  });
});

describe('callerRequiredSecrets / callerOptionalSecrets', () => {
  const info = describeConnectionTemplate('google', loadConnection('google'));
  const USER = [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REFRESH_TOKEN',
  ];

  it('google, user mode or no block: the user trio is required, the key optional', () => {
    for (const caller of [
      { connections: ['google'], google: { auth: 'user' as const, services: { docs: 'edit' } } },
      { connections: ['google'] },
      undefined,
    ]) {
      expect(callerRequiredSecrets(info, caller)).toEqual(USER);
      expect(callerOptionalSecrets(info, caller)).toEqual(['GOOGLE_SERVICE_ACCOUNT_KEY']);
    }
  });

  it('google, service-account mode: the key is required, the user trio optional', () => {
    const caller = {
      connections: ['google'],
      google: { auth: 'service-account' as const, services: { docs: 'edit' } },
    };
    expect(callerRequiredSecrets(info, caller)).toEqual(['GOOGLE_SERVICE_ACCOUNT_KEY']);
    expect(callerOptionalSecrets(info, caller)).toEqual(USER);
  });

  it('other templates: their own lists, whatever the caller', () => {
    const github = describeConnectionTemplate('github', loadConnection('github'));
    const caller = {
      connections: ['github'],
      google: { auth: 'service-account' as const, services: { docs: 'edit' } },
    };
    expect(callerRequiredSecrets(github, caller)).toEqual(github.requiredSecrets);
    expect(callerOptionalSecrets(github, caller)).toEqual(github.optionalSecrets);
  });
});

describe('cross-scope notes for a selection', () => {
  it('applies the sheets read + drive file note only to selections containing both', () => {
    expect(
      googleCrossScopeNotes({ auth: 'user', services: { sheets: 'read', drive: 'file' } }),
    ).toEqual([loadGoogleCatalog().crossScopeNotes[0].text]);
    expect(
      googleCrossScopeNotes({ auth: 'user', services: { sheets: 'read', drive: 'read' } }),
    ).toEqual([]);
    expect(
      googleCrossScopeNotes({ auth: 'user', services: { sheets: 'edit', drive: 'file' } }),
    ).toEqual([]);
  });

  it('googleBootNotes lists enabled, valid selections only', () => {
    const sel = { auth: 'user' as const, services: { sheets: 'read', drive: 'file' } };
    expect(
      googleBootNotes({
        on: { connections: ['google'], google: sel },
        off: { connections: [], google: sel },
        bad: { connections: ['google'], google: { ...sel, auth: 'nope' } as never },
      }),
    ).toEqual([`Caller "on": google: ${loadGoogleCatalog().crossScopeNotes[0].text}`]);
  });
});
