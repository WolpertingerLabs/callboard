/**
 * The scoped Google templates: what each one may reach, its token settings,
 * and the `-sa` twins' drift check.
 */
import { describe, it, expect } from 'vitest';

import {
  resolveCallerRoutesChecked,
  resolveRoutes,
  type RemoteServerConfig,
  type Route,
} from '../shared/config.js';
import { describeConnectionTemplate, loadConnection } from '../shared/connections.js';
import { isEndpointAllowed } from './tool-dispatch.js';

const SCOPE = 'https://www.googleapis.com/auth/';
const USER_TEMPLATES: Record<string, string> = {
  'google-gmail-metadata': 'gmail.metadata',
  'google-gmail-readonly': 'gmail.readonly',
  'google-calendar-freebusy': 'calendar.freebusy',
  'google-calendar-readonly': 'calendar.readonly',
  'google-drive-readonly': 'drive.readonly',
  'google-drive-file': 'drive.file',
  'google-sheets-readonly': 'spreadsheets.readonly',
};
const SA_TWINS = [
  'google-gmail-readonly',
  'google-calendar-readonly',
  'google-drive-readonly',
  'google-sheets-readonly',
];
const ALL = [...Object.keys(USER_TEMPLATES), ...SA_TWINS.map((a) => `${a}-sa`)];

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/** URLs no Google template may reach. */
const FORBIDDEN = [
  'https://oauth2.googleapis.com/token',
  'https://oauth2.googleapis.com/tokeninfo?access_token=x',
  'https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=x',
  'https://www.googleapis.com/oauth2/v1/userinfo',
  'https://www.googleapis.com/batch/drive/v3',
  'https://www.googleapis.com/batch/calendar/v3',
  'https://gmail.googleapis.com/batch/gmail/v1',
  'https://sheets.googleapis.com/batch',
  'https://www.googleapis.com/admin/directory/v1/users',
];

describe('scoped Google templates', () => {
  it.each(ALL)('%s loads and validates', (alias) => {
    expect(() => loadConnection(alias)).not.toThrow();
  });

  it.each(Object.entries(USER_TEMPLATES))('%s mints user OAuth tokens for %s only', (alias, s) => {
    const route = loadConnection(alias);
    expect(route.oauth2).toEqual({
      tokenUrl: 'https://oauth2.googleapis.com/token',
      grant: 'refresh_token',
      clientAuth: 'body',
      secretRefs: {
        clientId: 'GOOGLE_OAUTH_CLIENT_ID',
        clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
        refreshToken: 'GOOGLE_OAUTH_REFRESH_TOKEN',
      },
      scopes: [SCOPE + s],
    });
    expect(route.headers ?? {}).toEqual({});
    const info = describeConnectionTemplate(alias, route);
    expect(info.requiredSecrets.sort()).toEqual([
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'GOOGLE_OAUTH_REFRESH_TOKEN',
    ]);
    expect(info.optionalSecrets).toEqual([]);
  });

  it.each(SA_TWINS)('%s-sa is the service-account twin of %s (no drift)', (alias) => {
    const user = loadConnection(alias);
    const sa = loadConnection(`${alias}-sa`);
    expect(sa.allowedEndpoints).toEqual(user.allowedEndpoints);
    expect(sa.oauth2?.scopes).toEqual(user.oauth2?.scopes);
    expect(sa.oauth2?.tokenUrl).toEqual(user.oauth2?.tokenUrl);
    expect(sa.testConnection).toEqual(user.testConnection);
    expect(sa.oauth2?.grant).toBe('jwt_bearer');
    expect(sa.oauth2?.secretRefs).toEqual({ serviceAccountKey: 'GOOGLE_SERVICE_ACCOUNT_KEY' });
    expect(sa.oauth2?.subject).toBeUndefined();
    expect(describeConnectionTemplate(`${alias}-sa`, sa).requiredSecrets).toEqual([
      'GOOGLE_SERVICE_ACCOUNT_KEY',
    ]);
  });

  it('only the Gmail service-account template requires a subject', () => {
    for (const alias of SA_TWINS) {
      const required = loadConnection(`${alias}-sa`).oauth2?.subjectRequired === true;
      expect(required).toBe(alias === 'google-gmail-readonly');
    }
  });

  it.each(ALL)('%s cannot reach the token host, tokeninfo, or a batch endpoint', (alias) => {
    const { allowedEndpoints } = loadConnection(alias);
    for (const url of FORBIDDEN) expect(isEndpointAllowed(url, allowedEndpoints), url).toBe(false);
    for (const pattern of allowedEndpoints) {
      expect(pattern).not.toMatch(/\/batch/i);
      expect(pattern).not.toMatch(/oauth2|tokeninfo/i);
      // Every pattern is scoped to a service path, never a whole host.
      expect(pattern).not.toMatch(/^https:\/\/[^/]+\/\*\*$/);
    }
  });

  it.each(ALL)('%s has a read-only test request inside its own allowlist', (alias) => {
    const route = loadConnection(alias);
    const test = route.testConnection;
    expect(test).toBeDefined();
    if (!test) return;
    expect(isEndpointAllowed(test.url, route.allowedEndpoints)).toBe(true);
    expect(test.url).not.toContain('${');
    if (alias === 'google-calendar-freebusy') {
      // freeBusy.query is a POST, and a read.
      expect(test.method).toBe('POST');
      expect(test.body).toMatchObject({ items: [{ id: 'primary' }] });
    } else {
      expect(test.method ?? 'GET').toBe('GET');
    }
  });

  const WATCH_AND_CHANNELS = [
    `${CAL}/calendars/primary/events/watch`,
    `${CAL}/calendars/primary/events/watch?alt=json`,
    `${CAL}/calendars/primary/events/w%61tch`,
    `${CAL}/users/me/calendarList/watch`,
    `${CAL}/users/me/settings/watch`,
    `${CAL}/channels/stop`,
    `${DRIVE}/files/1AbC/watch`,
    `${DRIVE}/files/1AbC/watch?supportsAllDrives=true`,
    `${DRIVE}/changes/watch?pageToken=1`,
    `${DRIVE}/channels/stop`,
    `${GMAIL}/watch`,
    `${GMAIL}/stop`,
  ];

  const cases: Record<string, { allow: string[]; deny: string[] }> = {
    'google-gmail-metadata': {
      allow: [
        `${GMAIL}/profile`,
        `${GMAIL}/profile?alt=json`,
        `${GMAIL}/labels`,
        `${GMAIL}/labels/INBOX`,
        `${GMAIL}/messages?maxResults=10&labelIds=INBOX`,
        `${GMAIL}/messages/18c0ffee?format=metadata&metadataHeaders=Subject`,
        `${GMAIL}/threads`,
        `${GMAIL}/threads/18c0ffee?format=minimal`,
        `${GMAIL}/history?startHistoryId=12345`,
      ],
      deny: [
        `${GMAIL}/messages/18c0ffee/attachments/ANGjdJ`,
        `${GMAIL}/drafts`,
        `${GMAIL}/settings/filters`,
        `${GMAIL}/messagesX`,
        'https://gmail.googleapis.com/gmail/v1/users/someone@example.com/messages',
        `${DRIVE}/files`,
      ],
    },
    'google-gmail-readonly': {
      allow: [
        `${GMAIL}/messages?q=from:alice`,
        `${GMAIL}/messages/18c0ffee?format=full`,
        `${GMAIL}/messages/18c0ffee/attachments/ANGjdJ`,
        `${GMAIL}/drafts`,
        `${GMAIL}/drafts/r-123?format=full`,
      ],
      deny: [`${GMAIL}/settings/sendAs`, `${CAL}/users/me/calendarList`],
    },
    'google-calendar-freebusy': {
      allow: [`${CAL}/freeBusy`, `${CAL}/freeBusy?alt=json`],
      deny: [
        `${CAL}/users/me/calendarList`,
        `${CAL}/calendars/primary/events`,
        `${CAL}/colors`,
        `${CAL}/freeBusyX`,
      ],
    },
    'google-calendar-readonly': {
      allow: [
        `${CAL}/users/me/calendarList`,
        `${CAL}/users/me/calendarList?maxResults=1`,
        `${CAL}/users/me/calendarList/primary`,
        `${CAL}/users/me/settings`,
        `${CAL}/users/me/settings/timezone`,
        `${CAL}/calendars/primary`,
        `${CAL}/calendars/primary/events?timeMin=2026-01-01T00:00:00Z&singleEvents=true`,
        `${CAL}/calendars/someone%40example.com/events/evt123`,
        `${CAL}/calendars/primary/events/evt123?timeZone=Europe/Paris`,
        `${CAL}/calendars/primary/events/evt123/instances`,
        `${CAL}/freeBusy`,
        `${CAL}/freeBusy?alt=json`,
        `${CAL}/colors`,
        `${CAL}/colors?alt=json`,
      ],
      deny: [
        `${CAL}/calendars/primary/acl`,
        `${CAL}/calendars/primary/acl/watch`,
        `${CAL}/users/me/calendarListX`,
        `${CAL}/calendars/primary/eventsX`,
        `${CAL}/calendars/primary/events/evt123/instancesX`,
        `${DRIVE}/files`,
        `${GMAIL}/profile`,
      ],
    },
    'google-drive-readonly': {
      allow: [
        `${DRIVE}/files`,
        `${DRIVE}/files?q=name%20contains%20'x'&fields=files(id,name)`,
        `${DRIVE}/files/1AbC?alt=media`,
        `${DRIVE}/files/1AbC/export?mimeType=text/plain`,
        `${DRIVE}/files/1AbC/revisions`,
        `${DRIVE}/files/1AbC/revisions/2`,
        `${DRIVE}/about?fields=user`,
        `${DRIVE}/drives`,
        `${DRIVE}/drives/0AbC`,
        `${DRIVE}/changes?pageToken=123`,
        `${DRIVE}/changes/startPageToken`,
        `${DRIVE}/changes/startPageToken?supportsAllDrives=true`,
      ],
      deny: [
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        `${DRIVE}/filesX`,
        `${DRIVE}/aboutX`,
        `${DRIVE}/files/1AbC/permissions`,
        `${CAL}/colors`,
        'https://www.googleapis.com/drive/v2/files',
      ],
    },
    'google-drive-file': {
      allow: [
        `${DRIVE}/files`,
        `${DRIVE}/files?q=trashed%3Dfalse`,
        `${DRIVE}/files/1AbC`,
        `${DRIVE}/files/1AbC?fields=id,name`,
        `${DRIVE}/files/1AbC/export?mimeType=text/plain`,
        `${DRIVE}/files/1AbC/copy`,
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        'https://www.googleapis.com/upload/drive/v3/files/1AbC?uploadType=media',
        `${DRIVE}/about?fields=user`,
      ],
      deny: [
        // Sharing a file (publicly) goes through the permissions endpoints.
        `${DRIVE}/files/1AbC/permissions`,
        `${DRIVE}/files/1AbC/permissions?sendNotificationEmail=false`,
        `${DRIVE}/files/1AbC/permissions/anyoneWithLink`,
        `${DRIVE}/filesX`,
        `${DRIVE}/drives`,
        `${CAL}/colors`,
      ],
    },
    'google-sheets-readonly': {
      allow: [
        `${SHEETS}/1AbC`,
        `${SHEETS}/1AbC?includeGridData=false`,
        `${SHEETS}/1AbC/values/Sheet1!A1:B2`,
        `${SHEETS}/1AbC/values:batchGet?ranges=A1:B2`,
      ],
      deny: [`${DRIVE}/files`, `${SHEETS}X/1AbC`, 'https://docs.googleapis.com/v1/documents/1AbC'],
    },
  };

  it.each(ALL)('%s cannot register or stop push channels (watch endpoints)', (alias) => {
    const { allowedEndpoints } = loadConnection(alias);
    for (const url of WATCH_AND_CHANNELS) {
      expect(isEndpointAllowed(url, allowedEndpoints), url).toBe(false);
    }
  });

  it.each(ALL)('%s uses ** only after a boundary (x?** or x/**)', (alias) => {
    for (const pattern of loadConnection(alias).allowedEndpoints) {
      expect(pattern.replace(/[?/]\*\*/g, ''), pattern).not.toContain('**');
    }
  });

  for (const [alias, { allow, deny }] of Object.entries(cases)) {
    for (const variant of SA_TWINS.includes(alias) ? [alias, `${alias}-sa`] : [alias]) {
      it(`${variant} allows its service's read paths and nothing else`, () => {
        const { allowedEndpoints } = loadConnection(variant);
        for (const url of allow) expect(isEndpointAllowed(url, allowedEndpoints), url).toBe(true);
        for (const url of deny) expect(isEndpointAllowed(url, allowedEndpoints), url).toBe(false);
      });
    }
  }

  it('google.json is unchanged apart from recommending the scoped templates', () => {
    const route = loadConnection('google');
    expect(route.description).toMatch(/^Static token, full access: prefer the scoped google-\*/);
    expect(route.headers).toEqual({ Authorization: 'Bearer ${GOOGLE_API_TOKEN}' });
    expect(route.allowedEndpoints).toContain('https://www.googleapis.com/**');
    expect(route.oauth2).toBeUndefined();
  });
});

describe('one refresh token per scope set (documented fallback)', () => {
  it('a custom connector overriding a template alias can use its own refresh-token secret', () => {
    const template = loadConnection('google-gmail-readonly');
    const override: Route = {
      ...template,
      alias: 'google-gmail-readonly',
      secrets: {
        GOOGLE_OAUTH_CLIENT_ID: '${GOOGLE_OAUTH_CLIENT_ID}',
        GOOGLE_OAUTH_CLIENT_SECRET: '${GOOGLE_OAUTH_CLIENT_SECRET}',
        GMAIL_RO_REFRESH_TOKEN: '${GMAIL_RO_REFRESH_TOKEN}',
      },
      oauth2: {
        ...template.oauth2!,
        secretRefs: { ...template.oauth2!.secretRefs, refreshToken: 'GMAIL_RO_REFRESH_TOKEN' },
      },
    };
    const config = {
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      connectors: [override],
      callers: {
        'mail-agent': { connections: ['google-gmail-readonly', 'google-drive-readonly'] },
      },
    } as RemoteServerConfig;
    const env = {
      MAIL_AGENT_GOOGLE_OAUTH_CLIENT_ID: 'cid',
      MAIL_AGENT_GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
      MAIL_AGENT_GOOGLE_OAUTH_REFRESH_TOKEN: 'rt-drive',
      MAIL_AGENT_GMAIL_RO_REFRESH_TOKEN: 'rt-gmail',
    };
    Object.assign(process.env, env);
    try {
      const { routes, problems } = resolveCallerRoutesChecked(config, 'mail-agent');
      expect(problems).toEqual([]);
      const [gmail, drive] = resolveRoutes(routes, {}, 'mail-agent');
      const refreshTokenOf = (r: typeof gmail) => r.secrets[r.oauth2!.secretRefs.refreshToken!];
      expect(refreshTokenOf(gmail)).toBe('rt-gmail');
      expect(refreshTokenOf(drive)).toBe('rt-drive');
    } finally {
      for (const k of Object.keys(env)) Reflect.deleteProperty(process.env, k);
    }
  });
});
