/**
 * The Google catalog (src/connections/google-catalog.json): what each service
 * and level may reach, its scopes, its test request, and the cross-service
 * scope audit. These cases moved here from the per-scope templates' tests.
 */
import { describe, it, expect } from 'vitest';

import { allowlistPatternsOverlap, type GoogleAuthMode } from './config.js';
import { listAvailableConnections, loadConnection } from './connections.js';
import {
  GOOGLE_SERVICE_IDS,
  loadGoogleCatalog,
  validateGoogleCatalog,
  type GoogleCatalog,
  type GoogleLevel,
} from './google.js';
import { isEndpointAllowed, normalizeOutboundUrl } from '../remote/url-policy.js';

const SCOPE = 'https://www.googleapis.com/auth/';
const catalog = loadGoogleCatalog();

/** Every catalog level as `service.level`. */
const LEVELS: [string, GoogleLevel][] = GOOGLE_SERVICE_IDS.flatMap((svc) =>
  Object.entries(catalog.services[svc].levels).map(
    ([id, level]) => [`${svc}.${id}`, level] as [string, GoogleLevel],
  ),
);
const level = (key: string): GoogleLevel => {
  const found = LEVELS.find(([k]) => k === key);
  if (!found) throw new Error(`no level ${key}`);
  return found[1];
};

// ── Parity with the templates it replaces (temporary) ─────────────────────
//
// Deleted together with the templates. Its green run in the commit before is
// the proof that scopes, allowlists and tests moved unchanged.

describe('catalog parity with the per-scope templates', () => {
  const PARITY: [string, string, GoogleAuthMode][] = [
    ['google-gmail-metadata', 'gmail.metadata', 'user'],
    ['google-gmail-readonly', 'gmail.read', 'user'],
    ['google-gmail-readonly-sa', 'gmail.read', 'service-account'],
    ['google-calendar-freebusy', 'calendar.freebusy', 'user'],
    ['google-calendar-readonly', 'calendar.read', 'user'],
    ['google-calendar-readonly-sa', 'calendar.read', 'service-account'],
    ['google-drive-file', 'drive.file', 'user'],
    ['google-drive-readonly', 'drive.read', 'user'],
    ['google-drive-readonly-sa', 'drive.read', 'service-account'],
    ['google-sheets-readonly', 'sheets.read', 'user'],
    ['google-sheets-readonly-sa', 'sheets.read', 'service-account'],
    ['google-sheets', 'sheets.edit', 'user'],
    ['google-sheets-sa', 'sheets.edit', 'service-account'],
    ['google-docs', 'docs.edit', 'user'],
    ['google-docs-sa', 'docs.edit', 'service-account'],
    ['google-slides', 'slides.edit', 'user'],
    ['google-slides-sa', 'slides.edit', 'service-account'],
  ];

  it('covers all 17 templates and every catalog level in each mode it offers', () => {
    expect(PARITY).toHaveLength(17);
    const fromTemplates = PARITY.map(([, key, mode]) => `${key}/${mode}`).sort();
    const fromCatalog = LEVELS.flatMap(([key, l]) => l.auth.map((m) => `${key}/${m}`)).sort();
    expect(fromCatalog).toEqual(fromTemplates);
  });

  it.each(PARITY)('%s → %s (%s): scopes, allowlist and test moved verbatim', (alias, key, mode) => {
    const tpl = loadConnection(alias);
    const l = level(key);
    expect(l.scopes).toEqual(tpl.oauth2?.scopes);
    expect(l.allowedEndpoints).toEqual(tpl.allowedEndpoints);
    expect(l.testConnection).toEqual(tpl.testConnection);
    expect(l.auth).toContain(mode);
    expect(catalog.tokenUrl).toBe(tpl.oauth2?.tokenUrl);
    const m = catalog.auth[mode];
    expect(m.grant).toBe(tpl.oauth2?.grant);
    expect(m.secretRefs).toEqual(tpl.oauth2?.secretRefs);
    expect(m.clientAuth).toBe(tpl.oauth2?.clientAuth);
    if (mode === 'service-account') {
      expect(l.subjectRequired === true).toBe(tpl.oauth2?.subjectRequired === true);
    }
  });
});

// ── Invariants ────────────────────────────────────────────────────────────

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const SLIDES = 'https://slides.googleapis.com/v1/presentations';

/** URLs no level may reach. */
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

describe('Google catalog invariants', () => {
  it('offers exactly the ten scopes listed today, never drive, drive.metadata*, mail or cloud-platform', () => {
    const all = new Set(LEVELS.flatMap(([, l]) => l.scopes));
    expect([...all].sort()).toEqual(
      [
        'calendar.freebusy',
        'calendar.readonly',
        'documents',
        'drive.file',
        'drive.readonly',
        'gmail.metadata',
        'gmail.readonly',
        'presentations',
        'spreadsheets',
        'spreadsheets.readonly',
      ].map((s) => SCOPE + s),
    );
    for (const banned of ['drive', 'drive.metadata', 'drive.metadata.readonly', 'cloud-platform']) {
      expect(all.has(SCOPE + banned)).toBe(false);
    }
    expect(all.has('https://mail.google.com/')).toBe(false);
    // One scope per level.
    for (const [key, l] of LEVELS) expect(l.scopes, key).toHaveLength(1);
  });

  it('offers the service-account mode for exactly the levels that had -sa twins', () => {
    const sa = LEVELS.filter(([, l]) => l.auth.includes('service-account')).map(([k]) => k);
    expect(sa.sort()).toEqual(
      [
        'calendar.read',
        'docs.edit',
        'drive.read',
        'gmail.read',
        'sheets.edit',
        'sheets.read',
        'slides.edit',
      ].sort(),
    );
    for (const [key, l] of LEVELS) expect(l.auth, key).toContain('user');
  });

  it('requires a subject only for gmail.read', () => {
    const required = LEVELS.filter(([, l]) => l.subjectRequired).map(([k]) => k);
    expect(required).toEqual(['gmail.read']);
  });

  it('uses the user OAuth and service-account settings of the old templates', () => {
    expect(catalog.tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(catalog.auth).toEqual({
      user: {
        grant: 'refresh_token',
        clientAuth: 'body',
        secretRefs: {
          clientId: 'GOOGLE_OAUTH_CLIENT_ID',
          clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
          refreshToken: 'GOOGLE_OAUTH_REFRESH_TOKEN',
        },
      },
      'service-account': {
        grant: 'jwt_bearer',
        secretRefs: { serviceAccountKey: 'GOOGLE_SERVICE_ACCOUNT_KEY' },
      },
    });
  });

  it.each(LEVELS)('%s cannot reach the token host, tokeninfo, or a batch endpoint', (_k, l) => {
    for (const url of FORBIDDEN)
      expect(isEndpointAllowed(url, l.allowedEndpoints), url).toBe(false);
    for (const pattern of l.allowedEndpoints) {
      expect(pattern).not.toMatch(/\/batch/i);
      expect(pattern).not.toMatch(/oauth2|tokeninfo/i);
      // Every pattern is scoped to a service path, never a whole host.
      expect(pattern).not.toMatch(/^https:\/\/[^/]+\/\*\*$/);
    }
  });

  it.each(LEVELS)('%s cannot register or stop push channels (watch endpoints)', (_k, l) => {
    for (const url of WATCH_AND_CHANNELS) {
      expect(isEndpointAllowed(url, l.allowedEndpoints), url).toBe(false);
    }
  });

  it.each(LEVELS)('%s uses ** only after a boundary (x?** or x/**)', (_k, l) => {
    for (const pattern of l.allowedEndpoints) {
      expect(pattern.replace(/[?/]\*\*/g, ''), pattern).not.toContain('**');
    }
  });

  it.each(LEVELS)('%s has a read-only test request inside its own allowlist', (key, l) => {
    const test = l.testConnection;
    expect(isEndpointAllowed(test.url, l.allowedEndpoints)).toBe(true);
    expect(test.url).not.toContain('${');
    if (key === 'calendar.freebusy') {
      // freeBusy.query is a POST, and a read.
      expect(test.method).toBe('POST');
      expect(test.body).toMatchObject({ items: [{ id: 'primary' }] });
    } else {
      expect(test.method ?? 'GET').toBe('GET');
    }
  });

  it('drive.file and drive.read share one test request (about.get)', () => {
    expect(level('drive.file').testConnection).toEqual(level('drive.read').testConnection);
  });

  it('no two services have overlapping allowlist patterns (composing is a disjoint sum)', () => {
    const overlaps: string[] = [];
    for (let i = 0; i < GOOGLE_SERVICE_IDS.length; i++) {
      for (let j = i + 1; j < GOOGLE_SERVICE_IDS.length; j++) {
        const a = GOOGLE_SERVICE_IDS[i];
        const b = GOOGLE_SERVICE_IDS[j];
        const pa = Object.values(catalog.services[a].levels).flatMap((l) => l.allowedEndpoints);
        const pb = Object.values(catalog.services[b].levels).flatMap((l) => l.allowedEndpoints);
        for (const x of pa) {
          for (const y of pb) {
            // Exclusions included: an exclusion that overlapped another
            // service's pattern would subtract from that service.
            const strip = (p: string) => p.replace(/^!/, '');
            if (allowlistPatternsOverlap(strip(x), strip(y)))
              overlaps.push(`${a} ${x} / ${b} ${y}`);
          }
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  it('the catalog file is not a connection template', () => {
    const names = listAvailableConnections();
    expect(names).not.toContain('google-catalog');
    expect(() => loadConnection('google-catalog')).toThrow(/Unknown connection/);
  });

  it('is frozen once loaded', () => {
    expect(Object.isFrozen(catalog.services.sheets.levels.read.scopes)).toBe(true);
    expect(loadGoogleCatalog()).toBe(catalog);
  });
});

// ── Per-level allow and deny cases ────────────────────────────────────────

const CASES: Record<string, { allow: string[]; deny: string[] }> = {
  'gmail.metadata': {
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
  'gmail.read': {
    allow: [
      `${GMAIL}/messages?q=from:alice`,
      `${GMAIL}/messages/18c0ffee?format=full`,
      `${GMAIL}/messages/18c0ffee/attachments/ANGjdJ`,
      `${GMAIL}/drafts`,
      `${GMAIL}/drafts/r-123?format=full`,
    ],
    deny: [`${GMAIL}/settings/sendAs`, `${CAL}/users/me/calendarList`],
  },
  'calendar.freebusy': {
    allow: [`${CAL}/freeBusy`, `${CAL}/freeBusy?alt=json`],
    deny: [
      `${CAL}/users/me/calendarList`,
      `${CAL}/calendars/primary/events`,
      `${CAL}/colors`,
      `${CAL}/freeBusyX`,
    ],
  },
  'calendar.read': {
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
  'drive.read': {
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
  'drive.file': {
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
  'sheets.read': {
    allow: [
      `${SHEETS}/1AbC`,
      `${SHEETS}/1AbC?includeGridData=false`,
      `${SHEETS}/1AbC/values/Sheet1!A1:B2`,
      `${SHEETS}/1AbC/values:batchGet?ranges=A1:B2`,
    ],
    deny: [
      `${DRIVE}/files`,
      `${SHEETS}X/1AbC`,
      'https://docs.googleapis.com/v1/documents/1AbC',
      // spreadsheets.create stays unreachable (crossScopeNotes).
      SHEETS,
    ],
  },
  'sheets.edit': {
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
  'docs.edit': {
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
  'slides.edit': {
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

describe('per-level allowlists', () => {
  it('has cases for every level', () => {
    expect(Object.keys(CASES).sort()).toEqual(LEVELS.map(([k]) => k).sort());
  });

  it.each(Object.entries(CASES))("%s allows its service's paths and nothing else", (key, c) => {
    const { allowedEndpoints } = level(key);
    for (const url of c.allow) expect(isEndpointAllowed(url, allowedEndpoints), url).toBe(true);
    for (const url of c.deny) expect(isEndpointAllowed(url, allowedEndpoints), url).toBe(false);
  });

  describe('sheets.edit', () => {
    const { allowedEndpoints } = level('sheets.edit');
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

    it.each(Object.entries(METHODS))('allows %s (%j)', (_name, [, url]) => {
      expect(isEndpointAllowed(url, allowedEndpoints)).toBe(true);
      // What fetch() sends is what was matched.
      expect(normalizeOutboundUrl(url, allowedEndpoints, url)).toBe(url);
    });

    it('matches ranges however they are encoded, and `?**` queries with a /', () => {
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

    it('reaches only sheets.googleapis.com/v4/spreadsheets', () => {
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

    it("a %2F doesn't split a segment, and stays under /v4/spreadsheets", () => {
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

    it('refuses dot segments that would climb out of /v4/spreadsheets', () => {
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
    'docs.edit': {
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
    'slides.edit': {
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

  /** Off-service URLs neither editor level may reach. */
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

  for (const [key, { base, host, methods, bogus }] of Object.entries(EDITORS)) {
    describe(key, () => {
      const sibling = key === 'docs.edit' ? SLIDES : DOCS;
      const { allowedEndpoints } = level(key);

      it.each(Object.entries(methods))('allows %s (%j)', (_name, [, url]) => {
        expect(isEndpointAllowed(url, allowedEndpoints)).toBe(true);
        expect(normalizeOutboundUrl(url, allowedEndpoints, url)).toBe(url);
      });

      it(`reaches only ${base}`, () => {
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

      it(`a %2F or %3A doesn't split a segment, and stays under ${base}`, () => {
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

      it(`refuses dot segments that would climb out of ${base}`, () => {
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
    });
  }

  it('slides.edit allows presentations.get only for a one-segment ID', () => {
    // Discovery writes the path as `{+presentationId}` (reserved expansion,
    // which may contain "/"); Slides IDs don't, and `*` won't match one that does.
    const { allowedEndpoints } = level('slides.edit');
    expect(isEndpointAllowed(`${SLIDES}/1AbC`, allowedEndpoints)).toBe(true);
    expect(isEndpointAllowed(`${SLIDES}/a/b`, allowedEndpoints)).toBe(false);
  });
});

// ── Cross-service scope audit ─────────────────────────────────────────────

/** Every valid selection in a mode: each service off or one of its levels. */
function allSelections(mode: GoogleAuthMode): Record<string, string>[] {
  let out: Record<string, string>[] = [{}];
  for (const svc of GOOGLE_SERVICE_IDS) {
    const levels = Object.entries(catalog.services[svc].levels)
      .filter(([, l]) => l.auth.includes(mode))
      .map(([id]) => id);
    out = out.flatMap((sel) => [sel, ...levels.map((id) => ({ ...sel, [svc]: id }))]);
  }
  return out.filter((sel) => Object.keys(sel).length > 0);
}

/**
 * For one selection, the read-only levels another selected service's scope
 * makes writable (its API's write methods accept that scope), each with the
 * levels that cause it. Keyed like a crossScopeNotes `when`.
 */
function widenings(sel: Record<string, string>): string[] {
  const keys: string[] = [];
  for (const [svc, levelId] of Object.entries(sel)) {
    const l = catalog.services[svc as keyof GoogleCatalog['services']].levels[levelId];
    if (!l.readOnly) continue;
    const write = new Set(catalog.apiAccepts[svc as keyof GoogleCatalog['apiAccepts']].write);
    const causes = Object.entries(sel).filter(
      ([other, otherLevel]) =>
        other !== svc &&
        catalog.services[other as keyof GoogleCatalog['services']].levels[otherLevel].scopes.some(
          (s) => write.has(s),
        ),
    );
    if (causes.length === 0) continue;
    const when = Object.fromEntries([[svc, levelId], ...causes]);
    keys.push(noteKey(when));
  }
  return keys;
}

function noteKey(when: Record<string, string>): string {
  return Object.entries(when)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([s, l]) => `${s}=${l}`)
    .join(',');
}

describe('cross-service scope audit', () => {
  it('a read-only level grants no scope its own API writes with', () => {
    for (const svc of GOOGLE_SERVICE_IDS) {
      const write = new Set(catalog.apiAccepts[svc].write);
      for (const [id, l] of Object.entries(catalog.services[svc].levels)) {
        if (l.readOnly)
          expect(
            l.scopes.some((s) => write.has(s)),
            `${svc}.${id}`,
          ).toBe(false);
        else
          expect(
            l.scopes.some((s) => write.has(s)),
            `${svc}.${id}`,
          ).toBe(true);
        // Every level's own scope is accepted by its API's read methods.
        for (const s of l.scopes) expect(catalog.apiAccepts[svc].read, `${svc}.${id}`).toContain(s);
      }
    }
  });

  it('apiAccepts lists only scopes the catalog offers', () => {
    const offered = new Set(LEVELS.flatMap(([, l]) => l.scopes));
    for (const svc of GOOGLE_SERVICE_IDS) {
      for (const s of [...catalog.apiAccepts[svc].read, ...catalog.apiAccepts[svc].write]) {
        expect(offered.has(s), `${svc}: ${s}`).toBe(true);
      }
    }
  });

  it.each(['user', 'service-account'] as const)(
    'every widening in %s mode is exactly one documented crossScopeNotes entry',
    (mode) => {
      const selections = allSelections(mode);
      expect(selections.length).toBe(
        mode === 'user' ? 3 * 3 * 3 * 3 * 2 * 2 - 1 : 2 * 2 * 2 * 3 * 2 * 2 - 1,
      );
      const found = new Set(selections.flatMap(widenings));
      const documented = new Set(
        catalog.crossScopeNotes.map((n) => noteKey(n.when as Record<string, string>)),
      );
      if (mode === 'user') expect([...found].sort()).toEqual([...documented].sort());
      // drive.file is user-only, so the one documented widening can't arise.
      else expect([...found]).toEqual([]);
    },
  );

  it('the documented widening is sheets.read next to drive.file', () => {
    expect(catalog.crossScopeNotes.map((n) => n.when)).toEqual([{ sheets: 'read', drive: 'file' }]);
  });
});

// ── Catalog shape validation ──────────────────────────────────────────────

describe('validateGoogleCatalog', () => {
  const DELETE = Symbol('delete');
  /** A copy of the shipped catalog with one value at `path` replaced (or deleted). */
  function mutated(path: (string | number)[], value: unknown): unknown {
    const copy = structuredClone(catalog) as unknown;
    let node = copy as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
    const last = path[path.length - 1];
    if (value === DELETE) Reflect.deleteProperty(node, last);
    else node[last] = value;
    return copy;
  }

  it('accepts the shipped catalog', () => {
    expect(() => validateGoogleCatalog(structuredClone(catalog))).not.toThrow();
  });

  it.each([
    ['an unknown top-level field', ['extra'], 1, /root has unknown field "extra"/],
    ['a missing service', ['services', 'docs'], DELETE, /services must list exactly/],
    [
      'a level without scopes',
      ['services', 'gmail', 'levels', 'read', 'scopes'],
      [],
      /scopes must not be empty/,
    ],
    [
      'a level without a test',
      ['services', 'gmail', 'levels', 'read', 'testConnection'],
      DELETE,
      /testConnection must be an object/,
    ],
    [
      'an unknown auth mode',
      ['services', 'gmail', 'levels', 'read', 'auth'],
      ['user', 'magic'],
      /unknown mode "magic"/,
    ],
    [
      'subjectRequired on a user-only level',
      ['services', 'gmail', 'levels', 'metadata', 'subjectRequired'],
      true,
      /needs the service-account mode/,
    ],
    [
      'a note naming an unknown level',
      ['crossScopeNotes', 0, 'when', 'sheets'],
      'admin',
      /unknown level sheets/,
    ],
    [
      'a user grant other than refresh_token',
      ['auth', 'user', 'grant'],
      'client_credentials',
      /auth.user.grant must be "refresh_token"/,
    ],
  ] as [string, (string | number)[], unknown, RegExp][])(
    'rejects %s',
    (_name, path, value, message) => {
      expect(() => validateGoogleCatalog(mutated(path, value))).toThrow(message);
    },
  );
});
