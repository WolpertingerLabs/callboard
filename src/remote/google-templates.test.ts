/**
 * The scoped Google templates: what each one may reach, its token settings,
 * and the `-sa` twins' drift check.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  resolveCallerRoutesChecked,
  resolveRoutes,
  type OAuth2Config,
  type RemoteServerConfig,
  type Route,
} from '../shared/config.js';
import { describeConnectionTemplate, loadConnection } from '../shared/connections.js';
import { OAuth2ScopeError, TokenManager } from './oauth/token-manager.js';
import { resetSharedTokenManager, setSharedTokenManager } from './oauth/shared-token-manager.js';
import {
  dispatchTool,
  isEndpointAllowed,
  normalizeOutboundUrl,
  type ToolContext,
} from './tool-dispatch.js';

const SCOPE = 'https://www.googleapis.com/auth/';
const USER_TEMPLATES: Record<string, string> = {
  'google-gmail-metadata': 'gmail.metadata',
  'google-gmail-readonly': 'gmail.readonly',
  'google-calendar-freebusy': 'calendar.freebusy',
  'google-calendar-readonly': 'calendar.readonly',
  'google-drive-readonly': 'drive.readonly',
  'google-drive-file': 'drive.file',
  'google-sheets-readonly': 'spreadsheets.readonly',
  'google-sheets': 'spreadsheets',
  'google-docs': 'documents',
  'google-slides': 'presentations',
};
const SA_TWINS = [
  'google-gmail-readonly',
  'google-calendar-readonly',
  'google-drive-readonly',
  'google-sheets-readonly',
  'google-sheets',
  'google-docs',
  'google-slides',
];
const ALL = [...Object.keys(USER_TEMPLATES), ...SA_TWINS.map((a) => `${a}-sa`)];

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const SLIDES = 'https://slides.googleapis.com/v1/presentations';

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
  'https://sheets.googleapis.com/batch/sheets/v4',
  'https://docs.googleapis.com/batch',
  'https://docs.googleapis.com/batch/docs/v1',
  'https://slides.googleapis.com/batch',
  'https://slides.googleapis.com/batch/slides/v1',
  'https://docs.googleapis.com/$discovery/rest?version=v1',
  'https://slides.googleapis.com/$discovery/rest?version=v1',
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
    'google-sheets': {
      allow: [
        SHEETS,
        `${SHEETS}?fields=spreadsheetId`,
        `${SHEETS}/1AbC`,
        `${SHEETS}/1AbC?fields=sheets/properties/title`,
        `${SHEETS}/1AbC:batchUpdate`,
        `${SHEETS}/1AbC/values/Sheet1!A1:B2?valueInputOption=USER_ENTERED`,
        `${SHEETS}/1AbC/values/Sheet1!A1:append?insertDataOption=INSERT_ROWS`,
        `${SHEETS}/1AbC/values:batchUpdate`,
        `${SHEETS}/1AbC/sheets/0:copyTo`,
      ],
      deny: [
        `${DRIVE}/files`,
        `${DRIVE}/files/1AbC`,
        `${DRIVE}/files/1AbC/permissions`,
        `${SHEETS}X/1AbC`,
        'https://docs.googleapis.com/v1/documents/1AbC',
      ],
    },
    'google-docs': {
      allow: [
        DOCS,
        `${DOCS}/1AbC`,
        `${DOCS}/1AbC?includeTabsContent=true`,
        `${DOCS}/1AbC:batchUpdate`,
      ],
      deny: [
        `${DRIVE}/files/1AbC`,
        `${SHEETS}/1AbC`,
        `${SLIDES}/1AbC`,
        `${DOCS}X/1AbC`,
        `${DOCS}/1AbC/x`,
      ],
    },
    'google-slides': {
      allow: [
        SLIDES,
        `${SLIDES}/1AbC`,
        `${SLIDES}/1AbC:batchUpdate`,
        `${SLIDES}/1AbC/pages/p1`,
        `${SLIDES}/1AbC/pages/p1/thumbnail?thumbnailProperties.thumbnailSize=LARGE`,
      ],
      deny: [
        `${DRIVE}/files/1AbC`,
        `${SHEETS}/1AbC`,
        `${DOCS}/1AbC`,
        `${SLIDES}X/1AbC`,
        `${SLIDES}/1AbC/pages`,
      ],
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

  describe('google-sheets (read-write)', () => {
    /** Every method of the Sheets API v4 REST reference, by its HTTP request. */
    const METHODS: Record<string, [string, string]> = {
      'spreadsheets.create': ['POST', SHEETS],
      'spreadsheets.get': ['GET', `${SHEETS}/1AbC?includeGridData=false&ranges=Sheet1!A1:B2`],
      'spreadsheets.batchUpdate': ['POST', `${SHEETS}/1AbC:batchUpdate`],
      'spreadsheets.getByDataFilter': ['POST', `${SHEETS}/1AbC:getByDataFilter`],
      'spreadsheets.values.get': ['GET', `${SHEETS}/1AbC/values/Sheet1!A1:B2`],
      'spreadsheets.values.update': [
        'PUT',
        `${SHEETS}/1AbC/values/Sheet1!A1:B2?valueInputOption=USER_ENTERED`,
      ],
      'spreadsheets.values.append': [
        'POST',
        `${SHEETS}/1AbC/values/Sheet1!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      ],
      'spreadsheets.values.clear': ['POST', `${SHEETS}/1AbC/values/Sheet1!A1:B2:clear`],
      'spreadsheets.values.batchGet': [
        'GET',
        `${SHEETS}/1AbC/values:batchGet?ranges=A1:B2&ranges=Sheet2!C:C`,
      ],
      'spreadsheets.values.batchUpdate': ['POST', `${SHEETS}/1AbC/values:batchUpdate`],
      'spreadsheets.values.batchClear': ['POST', `${SHEETS}/1AbC/values:batchClear`],
      'spreadsheets.values.batchGetByDataFilter': [
        'POST',
        `${SHEETS}/1AbC/values:batchGetByDataFilter`,
      ],
      'spreadsheets.values.batchUpdateByDataFilter': [
        'POST',
        `${SHEETS}/1AbC/values:batchUpdateByDataFilter`,
      ],
      'spreadsheets.values.batchClearByDataFilter': [
        'POST',
        `${SHEETS}/1AbC/values:batchClearByDataFilter`,
      ],
      'spreadsheets.sheets.copyTo': ['POST', `${SHEETS}/1AbC/sheets/0:copyTo`],
      'spreadsheets.developerMetadata.get': ['GET', `${SHEETS}/1AbC/developerMetadata/42`],
      'spreadsheets.developerMetadata.search': ['POST', `${SHEETS}/1AbC/developerMetadata:search`],
    };

    for (const alias of ['google-sheets', 'google-sheets-sa']) {
      const { allowedEndpoints } = loadConnection(alias);

      it.each(Object.entries(METHODS))(`${alias} allows %s (%j)`, (_name, [, url]) => {
        expect(isEndpointAllowed(url, allowedEndpoints)).toBe(true);
        // What fetch() sends is what was matched.
        expect(normalizeOutboundUrl(url, allowedEndpoints, url)).toBe(url);
      });

      it(`${alias} matches ranges however they are encoded, and \`?**\` queries with a /`, () => {
        for (const url of [
          `${SHEETS}/1AbC/values/Sheet1%21A1%3AB2`,
          `${SHEETS}/1AbC/values/Sheet1%21A1%3AB2:append`,
          `${SHEETS}/1AbC/values/'My%20Sheet'!A:A`,
          `${SHEETS}/1AbC/values/%27My%20Sheet%27%21A%3AA:clear`,
          `${SHEETS}/1AbC/values/Tab%2FTwo!A1`,
          `${SHEETS}/1AbC/values/NamedRange`,
          `${SHEETS}/1AbC?fields=sheets/properties/title`,
          `${SHEETS}/1AbC/values/A1?valueRenderOption=FORMULA&x=a/b`,
          `${SHEETS}/1AbC/values:batchGet?ranges=Sheet1!A1:B2&fields=valueRanges/values`,
          `${SHEETS}?fields=spreadsheetId,sheets/properties`,
        ]) {
          expect(isEndpointAllowed(url, allowedEndpoints), url).toBe(true);
          expect(normalizeOutboundUrl(url, allowedEndpoints, url), url).toBe(url);
        }
      });

      it(`${alias} reaches only sheets.googleapis.com/v4/spreadsheets`, () => {
        for (const pattern of allowedEndpoints) {
          expect(pattern.startsWith(SHEETS), pattern).toBe(true);
          expect(pattern, pattern).not.toContain('**/');
        }
        for (const url of [
          // Drive: sharing, permissions, delete, trash, copy, upload stay out.
          `${DRIVE}/files`,
          `${DRIVE}/files/1AbC`,
          `${DRIVE}/files/1AbC?supportsAllDrives=true`,
          `${DRIVE}/files/1AbC/permissions`,
          `${DRIVE}/files/1AbC/permissions/anyoneWithLink`,
          `${DRIVE}/files/1AbC/copy`,
          `${DRIVE}/files/trash`,
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
          'https://www.googleapis.com/drive/v2/files/1AbC',
          'https://drive.googleapis.com/drive/v3/files/1AbC',
          'https://drive.googleapis.com/drive/v3/files/1AbC/permissions',
          // Other Google APIs and hosts.
          'https://docs.googleapis.com/v1/documents/1AbC',
          'https://sheets.googleapis.com/v3/spreadsheets/1AbC',
          'https://sheets.googleapis.com/v4/1AbC',
          'https://sheets.googleapis.com/$discovery/rest?version=v4',
          'https://www.googleapis.com/v4/spreadsheets/1AbC',
          'http://sheets.googleapis.com/v4/spreadsheets/1AbC',
          'https://sheets.googleapis.com.evil.example/v4/spreadsheets/1AbC',
          'https://sheets.googleapis.com@evil.example/v4/spreadsheets/1AbC',
          'https://evil.example/v4/spreadsheets/1AbC',
          // Batch endpoints (sub-requests the path rules can't see).
          'https://sheets.googleapis.com/batch',
          'https://sheets.googleapis.com/batch/sheets/v4',
          'https://www.googleapis.com/batch/drive/v3',
          // Prefix tricks and paths the API doesn't have.
          `${SHEETS}X`,
          `${SHEETS}X/1AbC`,
          `${SHEETS}:batchUpdate`,
          `${SHEETS}/1AbC/values`,
          `${SHEETS}/1AbC/values/A1/B2`,
          `${SHEETS}/1AbC/valuesX:batchGet`,
          `${SHEETS}/1AbC/values:batchGetX`,
          `${SHEETS}/1AbC/sheets/0`,
          `${SHEETS}/1AbC/sheets/0:copyToX`,
          `${SHEETS}/1AbC/developerMetadata`,
          `${SHEETS}/1AbC/developerMetadata:searchX`,
          `${SHEETS}/1AbC/developerMetadata/42/x`,
          `${SHEETS}/1AbC/permissions`,
          // An encoded ":" in a method suffix that is its own segment isn't
          // decoded by the matcher, so it matches no pattern (but see the
          // %2F case below).
          `${SHEETS}/1AbC/values%3AbatchUpdate`,
          `${SHEETS}/1AbC/developerMetadata%3Asearch`,
        ]) {
          expect(isEndpointAllowed(url, allowedEndpoints), url).toBe(false);
        }
      });

      it(`${alias}: a %2F doesn't split a segment, and stays under /v4/spreadsheets`, () => {
        // `*` is [^/]*, so `{id}%2F…` is one segment for `…/spreadsheets/*`
        // (CONNECTIONS.md "Sheets method suffixes"). Sent as written.
        for (const url of [
          `${SHEETS}/1AbC%2Fvalues%3AbatchUpdate`,
          `${SHEETS}/1AbC%2Fvalues:batchUpdate`,
          `${SHEETS}/1AbC%2fpermissions`,
        ]) {
          expect(isEndpointAllowed(url, allowedEndpoints), url).toBe(true);
          const sent = normalizeOutboundUrl(url, allowedEndpoints, url);
          expect(sent, url).toBe(url);
          expect(new URL(sent).host).toBe('sheets.googleapis.com');
          expect(new URL(sent).pathname.startsWith('/v4/spreadsheets/')).toBe(true);
        }
        // ...but a dot segment behind it is still refused.
        for (const url of [
          `${SHEETS}/1AbC%2F..%2F..%2Fbatch`,
          `${SHEETS}/1AbC%2F%2e%2e%2F%2e%2e%2Fbatch`,
          `${SHEETS}/1AbC%5C..%5C..%5Cbatch`,
        ]) {
          expect(() => normalizeOutboundUrl(url, allowedEndpoints, url), url).toThrow(
            /Endpoint not allowed/,
          );
        }
      });

      it(`${alias} refuses dot segments that would climb out of /v4/spreadsheets`, () => {
        for (const url of [
          `${SHEETS}/x/../..`,
          `${SHEETS}/x/../../../drive/v3/files`,
          `${SHEETS}/1AbC/values/..`,
          `${SHEETS}/1AbC/values/%2e%2e`,
          `${SHEETS}/1AbC/values/..%2f..%2f..%2f..%2fdrive%2fv3%2ffiles`,
          `${SHEETS}/1AbC/values/.`,
          `${SHEETS}/%2e%2e/%2e%2e/drive/v3/files`,
        ]) {
          expect(() => normalizeOutboundUrl(url, allowedEndpoints, url), url).toThrow(
            /Endpoint not allowed/,
          );
        }
      });
    }
  });

  /**
   * Google Docs v1 and Slides v1: every method in the Discovery documents
   * (docs.googleapis.com and slides.googleapis.com `$discovery/rest?version=v1`,
   * revision 20261118), by its HTTP request, with each documented query
   * parameter on the methods that take one. Query strings don't take part in
   * path matching; the `?**` entries let them through.
   */
  const EDITORS: Record<
    string,
    {
      base: string;
      host: string;
      methods: Record<string, [string, string]>;
      /** Paths on the same host and version that the API doesn't have. */
      bogus: string[];
    }
  > = {
    'google-docs': {
      base: DOCS,
      host: 'docs.googleapis.com',
      methods: {
        'documents.create': ['POST', DOCS],
        'documents.get': [
          'GET',
          `${DOCS}/1AbC?includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED`,
        ],
        'documents.batchUpdate': ['POST', `${DOCS}/1AbC:batchUpdate`],
      },
      bogus: [
        `${DOCS}X`,
        `${DOCS}X/1AbC`,
        `${DOCS}:batchUpdate`,
        `${DOCS}/1AbC/tabs`,
        `${DOCS}/1AbC/x/y`,
        'https://docs.googleapis.com/v1/1AbC',
        'https://docs.googleapis.com/v2/documents/1AbC',
        'https://docs.googleapis.com/v1beta/documents/1AbC',
        'https://docs.googleapis.com/V1/documents/1AbC',
      ],
    },
    'google-slides': {
      base: SLIDES,
      host: 'slides.googleapis.com',
      methods: {
        'presentations.create': ['POST', SLIDES],
        'presentations.get': [
          'GET',
          `${SLIDES}/1AbC?commentsViewMode=COMMENTS_VIEW_MODE_OMITTED&fields=slides.objectId`,
        ],
        'presentations.batchUpdate': ['POST', `${SLIDES}/1AbC:batchUpdate`],
        'presentations.pages.get': [
          'GET',
          `${SLIDES}/1AbC/pages/g1234_0?commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED`,
        ],
        'presentations.pages.getThumbnail': [
          'GET',
          `${SLIDES}/1AbC/pages/g1234_0/thumbnail?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=WIDTH2000_PX`,
        ],
      },
      bogus: [
        `${SLIDES}X`,
        `${SLIDES}X/1AbC`,
        `${SLIDES}:batchUpdate`,
        `${SLIDES}/1AbC/pages`,
        `${SLIDES}/1AbC/pagesX/p1`,
        `${SLIDES}/1AbC/pages/p1/thumbnailX`,
        `${SLIDES}/1AbC/pages/p1/thumbnail/x`,
        `${SLIDES}/1AbC/pages/p1/x`,
        `${SLIDES}/1AbC/x`,
        'https://slides.googleapis.com/v1/1AbC',
        'https://slides.googleapis.com/v2/presentations/1AbC',
        'https://slides.googleapis.com/V1/presentations/1AbC',
      ],
    },
  };

  /** Off-service URLs neither editor template may reach. */
  const OFF_SERVICE = [
    // Drive: sharing, permissions, delete, trash, copy, export, upload stay out.
    `${DRIVE}/files`,
    `${DRIVE}/files/1AbC`,
    `${DRIVE}/files/1AbC?supportsAllDrives=true`,
    `${DRIVE}/files/1AbC/permissions`,
    `${DRIVE}/files/1AbC/permissions/anyoneWithLink`,
    `${DRIVE}/files/1AbC/copy`,
    `${DRIVE}/files/1AbC/export?mimeType=application/pdf`,
    `${DRIVE}/files/1AbC/comments`,
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    'https://drive.googleapis.com/drive/v3/files/1AbC/permissions',
    // Token host, tokeninfo, userinfo.
    'https://oauth2.googleapis.com/token',
    'https://oauth2.googleapis.com/tokeninfo?access_token=x',
    'https://www.googleapis.com/oauth2/v3/userinfo',
    'https://openidconnect.googleapis.com/v1/userinfo',
    // The other editors' APIs.
    `${SHEETS}/1AbC`,
    // Hosts that only look like the service.
    'https://www.googleapis.com/v1/documents/1AbC',
    'https://www.googleapis.com/v1/presentations/1AbC',
    'https://docs.google.com/document/d/1AbC/export?format=txt',
    'https://docs.google.com/presentation/d/1AbC/export/pdf',
    'https://evil.example/v1/documents/1AbC',
    'https://evil.example/v1/presentations/1AbC',
    // Where thumbnails live: not allowlisted, and not to be (see CONNECTIONS.md).
    'https://lh3.googleusercontent.com/abc=s1600',
    'https://lh7-rt.googleusercontent.com/slidesz/abc',
  ];

  for (const [user, { base, host, methods, bogus }] of Object.entries(EDITORS)) {
    describe(`${user} (read-write)`, () => {
      const sibling = user === 'google-docs' ? SLIDES : DOCS;

      for (const alias of [user, `${user}-sa`]) {
        const { allowedEndpoints } = loadConnection(alias);

        it.each(Object.entries(methods))(`${alias} allows %s (%j)`, (_name, [, url]) => {
          expect(isEndpointAllowed(url, allowedEndpoints)).toBe(true);
          // What fetch() sends is what was matched.
          expect(normalizeOutboundUrl(url, allowedEndpoints, url)).toBe(url);
        });

        it(`${alias} reaches only ${base}`, () => {
          for (const pattern of allowedEndpoints) {
            expect(
              pattern === base || pattern.startsWith(`${base}/`) || pattern.startsWith(`${base}?`),
              pattern,
            ).toBe(true);
            expect(pattern, pattern).not.toContain('**/');
          }
          for (const url of [
            ...OFF_SERVICE,
            sibling,
            `${sibling}/1AbC`,
            ...bogus,
            `http://${host}${new URL(base).pathname}/1AbC`,
            `https://${host}.evil.example${new URL(base).pathname}/1AbC`,
            `https://${host}@evil.example${new URL(base).pathname}/1AbC`,
            `https://${host}/batch`,
            `https://${host}/$discovery/rest?version=v1`,
            // An encoded ":" isn't decoded by the matcher: `{id}%3AbatchUpdate`
            // is still one segment, so it matches `…/*` (asserted below) but a
            // suffix that is its own segment doesn't.
            `${base}%3AbatchUpdate`,
          ]) {
            expect(isEndpointAllowed(url, allowedEndpoints), url).toBe(false);
          }
        });

        it(`${alias}: a %2F or %3A doesn't split a segment, and stays under ${base}`, () => {
          // `*` is [^/]*, so `{id}%2F…` is one segment for `…/{collection}/*`.
          for (const url of [
            `${base}/1AbC%2Fx`,
            `${base}/1AbC%3AbatchUpdate`,
            `${base}/1AbC%2F..x`,
          ]) {
            expect(isEndpointAllowed(url, allowedEndpoints), url).toBe(true);
            const sent = normalizeOutboundUrl(url, allowedEndpoints, url);
            expect(sent, url).toBe(url);
            expect(new URL(sent).host).toBe(host);
            expect(new URL(sent).pathname.startsWith(`${new URL(base).pathname}/`)).toBe(true);
          }
        });

        it(`${alias} refuses dot segments that would climb out of ${base}`, () => {
          for (const url of [
            `${base}/x/../..`,
            `${base}/x/../../../drive/v3/files`,
            `${base}/..`,
            `${base}/%2e%2e`,
            `${base}/%2E%2E/%2e%2e/batch`,
            `${base}/1AbC%2F..%2F..%2Fbatch`,
            `${base}/1AbC%2F%2e%2e%2F%2e%2e%2Fbatch`,
            `${base}/1AbC%5C..%5C..%5Cbatch`,
            `${base}/1AbC\\..\\..\\batch`,
            `${base}/.`,
          ]) {
            expect(() => normalizeOutboundUrl(url, allowedEndpoints, url), url).toThrow(
              /Endpoint not allowed/,
            );
          }
        });
      }
    });
  }

  it('google-slides allows presentations.get only for a one-segment ID', () => {
    // Discovery writes the path as `{+presentationId}` (reserved expansion,
    // which may contain "/"); Slides IDs don't, and `*` won't match one that does.
    const { allowedEndpoints } = loadConnection('google-slides');
    expect(isEndpointAllowed(`${SLIDES}/1AbC`, allowedEndpoints)).toBe(true);
    expect(isEndpointAllowed(`${SLIDES}/a/b`, allowedEndpoints)).toBe(false);
  });
});

/** A template's oauth2 block (every Google template has one). */
function oauthOf(alias: string): OAuth2Config {
  const { oauth2 } = loadConnection(alias);
  if (!oauth2) throw new Error(`${alias} has no oauth2 block`);
  return oauth2;
}

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

  it('google-sheets can read its own refresh token next to google-drive-readonly', () => {
    const template = loadConnection('google-sheets');
    const oauth2 = oauthOf('google-sheets');
    const override: Route = {
      ...template,
      alias: 'google-sheets',
      secrets: {
        GOOGLE_OAUTH_CLIENT_ID: '${GOOGLE_OAUTH_CLIENT_ID}',
        GOOGLE_OAUTH_CLIENT_SECRET: '${GOOGLE_OAUTH_CLIENT_SECRET}',
        SHEETS_RW_REFRESH_TOKEN: '${SHEETS_RW_REFRESH_TOKEN}',
      },
      oauth2: {
        ...oauth2,
        secretRefs: { ...oauth2.secretRefs, refreshToken: 'SHEETS_RW_REFRESH_TOKEN' },
      },
    };
    const config = {
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      connectors: [override],
      callers: {
        'sheets-agent': { connections: ['google-sheets', 'google-drive-readonly'] },
      },
    } as RemoteServerConfig;
    const env = {
      SHEETS_AGENT_GOOGLE_OAUTH_CLIENT_ID: 'cid',
      SHEETS_AGENT_GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
      SHEETS_AGENT_GOOGLE_OAUTH_REFRESH_TOKEN: 'rt-drive',
      SHEETS_AGENT_SHEETS_RW_REFRESH_TOKEN: 'rt-sheets',
    };
    Object.assign(process.env, env);
    try {
      const { routes, problems } = resolveCallerRoutesChecked(config, 'sheets-agent');
      expect(problems).toEqual([]);
      const [sheets, drive] = resolveRoutes(routes, {}, 'sheets-agent');
      const refreshTokenOf = (r: typeof sheets) =>
        r.secrets[r.oauth2?.secretRefs.refreshToken ?? ''];
      expect(sheets.oauth2?.scopes).toEqual([SCOPE + 'spreadsheets']);
      expect(refreshTokenOf(sheets)).toBe('rt-sheets');
      expect(refreshTokenOf(drive)).toBe('rt-drive');
    } finally {
      for (const k of Object.keys(env)) Reflect.deleteProperty(process.env, k);
    }
  });
});

describe('one refresh token granted several Sheets/Drive scopes', () => {
  /** Mint for `alias` against a token endpoint that reports `granted`. */
  async function mint(alias: string, granted: string[]) {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ access_token: 'at', expires_in: 3600, scope: granted.join(' ') }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const tm = new TokenManager({ fetchImpl, now: () => 1_000_000 });
    const result = await tm
      .getToken({ connection: alias, caller: 'alice' }, oauthOf(alias), (n) => n)
      .catch((e: unknown) => e);
    const sent = new URLSearchParams(fetchImpl.mock.calls[0][1]?.body as string).get('scope');
    return { result, sent };
  }
  const RW = SCOPE + 'spreadsheets';
  const RO = SCOPE + 'spreadsheets.readonly';
  const DRIVE_RO = SCOPE + 'drive.readonly';

  it.each([
    ['google-sheets', RW],
    ['google-sheets-readonly', RO],
    ['google-drive-readonly', DRIVE_RO],
  ])('%s asks for exactly %s on every refresh', async (alias, scope) => {
    const { result, sent } = await mint(alias, [scope]);
    expect(sent).toBe(scope);
    expect(result).toMatchObject({ grantedScopes: [scope] });
  });

  // If Google returns the whole grant instead of narrowing, every template on
  // that token fails closed. Scopes compare as strings: spreadsheets.readonly
  // is "extra" to a google-sheets request even though spreadsheets covers it.
  it.each([
    ['google-sheets', [RW, RO], RO],
    ['google-sheets-readonly', [RW, RO], RW],
    ['google-sheets', [RW, DRIVE_RO], DRIVE_RO],
    ['google-drive-readonly', [RW, DRIVE_RO], RW],
  ])('%s refuses an un-narrowed grant of %j, naming %s', async (alias, granted, extra) => {
    const { result } = await mint(alias, granted);
    expect(result).toBeInstanceOf(OAuth2ScopeError);
    expect((result as Error).message).toContain(`broader than this connection allows (${extra})`);
  });
});

describe('one master refresh token for Docs, Slides and Sheets', () => {
  const DOCS_RW = SCOPE + 'documents';
  const SLIDES_RW = SCOPE + 'presentations';
  const SHEETS_RW = SCOPE + 'spreadsheets';
  const SUPERSET = [DOCS_RW, SLIDES_RW, SHEETS_RW];

  /**
   * test_connection on a real template's route, against a token endpoint that
   * answers with `scopeFor(requested)`. The test request itself is dropped so
   * nothing leaves the process: the mint is what's under test.
   */
  async function testConnection(alias: string, scopeFor: (requested: string) => string) {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const requested = new URLSearchParams(init?.body as string).get('scope') ?? '';
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: 'at', expires_in: 3600, scope: scopeFor(requested) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    setSharedTokenManager(new TokenManager({ fetchImpl }));
    try {
      const routes = resolveRoutes(
        [{ ...loadConnection(alias), alias, testConnection: undefined }],
        {
          GOOGLE_OAUTH_CLIENT_ID: 'cid',
          GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
          GOOGLE_OAUTH_REFRESH_TOKEN: 'rt-master',
        },
        'alice',
      );
      const context = {
        callerAlias: 'alice',
        origin: 'agent',
        ingestorManager: {} as ToolContext['ingestorManager'],
        refreshRoutes: () => undefined,
      } as ToolContext;
      const result = (await dispatchTool(
        'test_connection',
        { connection: alias },
        routes,
        context,
      )) as Record<string, unknown>;
      return { result, fetchImpl };
    } finally {
      resetSharedTokenManager();
    }
  }

  it.each([
    ['google-docs', DOCS_RW],
    ['google-slides', SLIDES_RW],
    ['google-sheets', SHEETS_RW],
  ])(
    '%s: if Google narrows on refresh, test_connection reports the one scope granted',
    async (alias, scope) => {
      const { result, fetchImpl } = await testConnection(alias, (requested) => requested);
      expect(new URLSearchParams(fetchImpl.mock.calls[0][1]?.body as string).get('scope')).toBe(
        scope,
      );
      expect(result).toMatchObject({
        success: true,
        oauth2: { tokenMinted: true, requestedScopes: [scope], grantedScopes: [scope] },
      });
    },
  );

  it.each([
    ['google-docs', DOCS_RW],
    ['google-slides', SLIDES_RW],
    ['google-sheets', SHEETS_RW],
  ])(
    "%s: if Google doesn't narrow, test_connection fails with the broader-scopes error",
    async (alias, scope) => {
      const { result } = await testConnection(alias, () => SUPERSET.join(' '));
      expect(result).toMatchObject({
        success: false,
        oauth2: { tokenMinted: false, requestedScopes: [scope] },
      });
      const extra = SUPERSET.filter((s) => s !== scope).join(', ');
      expect(String(result.error)).toContain(
        `granted scopes broader than this connection allows (${extra})`,
      );
      // No grantedScopes on a refusal: the extra scopes are named in the error.
      expect((result.oauth2 as Record<string, unknown>).grantedScopes).toBeUndefined();
    },
  );
});
