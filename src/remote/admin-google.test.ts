/**
 * Google selection admin API (src/remote/admin-google.ts).
 *
 * plans/google-unified.md, test plan step 16: the catalog payload (no
 * allowlists or tests), GET/PUT/DELETE of a caller's selection, the
 * validator's messages as 400s, 404 for unknown and prototype-key aliases,
 * only `callers.<alias>.google` written (the rest of remote.config.json
 * byte-identical), refreshCaller and audit called, and the audit line never
 * carrying the subject.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAdminRouter } from './admin.js';
import { createApp } from './server.js';
import { IngestorManager } from './ingestors/manager.js';
import { resetAuditLogState } from './audit-log.js';
import {
  getRemoteConfigPath,
  loadRemoteConfig,
  type RemoteServerConfig,
} from '../shared/config.js';
import { loadGoogleCatalog, validateGoogleSelection } from '../shared/google.js';
import { generateKeyBundle } from '../shared/crypto/index.js';
import { generateSalt, hashPassword } from '../auth/password.js';
import type { AdminGoogleCatalog, AdminGoogleSelection } from './admin-types.js';

const SUBJECT = 'subject-canary@example.com';

let configDir: string;
let server: Server | undefined;
let base: string;
let audited: { action: string; details?: Record<string, unknown> }[];
let refreshed: string[];

/** Hand-written config, with keys and values the daemon would never write
 *  itself, so a whole-file rewrite would show up in the byte comparison. */
function rawConfig(): Record<string, unknown> {
  return {
    host: '127.0.0.1',
    port: 0,
    rateLimitPerMinute: 1000,
    connectors: [],
    callers: {
      alice: { name: 'Alice', connections: ['google', 'github'], env: { X: '${ALICE_X}' } },
      bob: {
        connections: ['google'],
        google: { auth: 'service-account', subject: SUBJECT, services: { gmail: 'read' } },
      },
      carol: { connections: [] },
    },
    $comment: 'kept verbatim',
  };
}

function writeRaw(raw: Record<string, unknown>): string {
  fs.mkdirSync(configDir, { recursive: true });
  const text = JSON.stringify(raw, null, 2);
  fs.writeFileSync(getRemoteConfigPath(), text);
  return text;
}

function readRaw(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(getRemoteConfigPath(), 'utf8')) as Record<string, unknown>;
}

/** The file with one caller's `google` key removed, re-serialised the same way. */
function withoutGoogle(text: string, alias: string): string {
  const raw = JSON.parse(text) as { callers: Record<string, Record<string, unknown>> };
  delete raw.callers[alias].google;
  return JSON.stringify(raw, null, 2);
}

async function startRouter(): Promise<void> {
  audited = [];
  refreshed = [];
  const mgr = new IngestorManager(loadRemoteConfig());
  const router = createAdminRouter({
    getSessionsSnapshot: () => [],
    ingestorManager: () => mgr,
    loadConfig: () => loadRemoteConfig(),
    resolveRoutesForCaller: () => [],
    refreshCaller: (alias) => refreshed.push(alias),
    reloadPeer: () => undefined,
    removePeer: () => undefined,
    audit: (action, details) => audited.push({ action, details }),
    version: 'test',
    port: 0,
    startedAt: Date.now(),
  });
  const app = express();
  app.use('/api/admin', express.json(), router);
  await new Promise<void>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/admin`;
      resolve();
    });
    server = s;
  });
}

async function req(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

beforeEach(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-admin-google-'));
  process.env.MCP_CONFIG_DIR = configDir;
  resetAuditLogState();
  writeRaw(rawConfig());
  await startRouter();
});

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) await new Promise<void>((r) => s.close(() => r()));
  delete process.env.MCP_CONFIG_DIR;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('GET /google/catalog', () => {
  it('lists services, levels, scopes, summaries, modes and notes in catalog order', async () => {
    const res = await req('GET', '/google/catalog');
    expect(res.status).toBe(200);
    const body = res.body as AdminGoogleCatalog;
    const catalog = loadGoogleCatalog();
    expect(body.services.map((s) => s.id)).toEqual([
      'gmail',
      'calendar',
      'drive',
      'sheets',
      'docs',
      'slides',
    ]);
    for (const svc of body.services) {
      const c = catalog.services[svc.id];
      expect(svc).toMatchObject({ name: c.name, docsUrl: c.docsUrl, enableApi: c.enableApi });
      expect(svc.levels.map((l) => l.id)).toEqual(Object.keys(c.levels));
      for (const l of svc.levels) {
        const cl = c.levels[l.id];
        expect(l).toEqual({
          id: l.id,
          summary: cl.summary,
          scopes: cl.scopes,
          auth: cl.auth,
          ...(cl.subjectRequired === true && { subjectRequired: true }),
        });
      }
    }
    expect(body.crossScopeNotes).toEqual(catalog.crossScopeNotes);
    // Each mode's credential names, for the editor's secrets section.
    expect(body.authModes).toEqual([
      {
        id: 'user',
        secrets: [
          'GOOGLE_OAUTH_CLIENT_ID',
          'GOOGLE_OAUTH_CLIENT_SECRET',
          'GOOGLE_OAUTH_REFRESH_TOKEN',
        ],
      },
      { id: 'service-account', secrets: ['GOOGLE_SERVICE_ACCOUNT_KEY'] },
    ]);
  });

  it('carries no allowlists or test requests', async () => {
    const res = await req('GET', '/google/catalog');
    expect(res.text).not.toContain('allowedEndpoints');
    expect(res.text).not.toContain('testConnection');
    expect(res.text).not.toContain('apiAccepts');
    expect(res.text).not.toContain('gmail.googleapis.com/gmail/v1/users/me/messages');
  });
});

describe('GET /callers/:alias/google', () => {
  it('a caller with no selection: enabled, null, and the "needs" problem', async () => {
    const res = await req('GET', '/callers/alice/google');
    expect(res.status).toBe(200);
    const body = res.body as AdminGoogleSelection;
    expect(body.enabled).toBe(true);
    expect(body.selection).toBeNull();
    expect(body.consentScopes).toEqual([]);
    expect(body.notes).toEqual([]);
    expect(body.problem).toContain('needs callers.alice.google');
  });

  it('a service-account caller: the selection (subject included), sorted consent scopes', async () => {
    const res = await req('GET', '/callers/bob/google');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toEqual({
      enabled: true,
      selection: { auth: 'service-account', subject: SUBJECT, services: { gmail: 'read' } },
      consentScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      notes: [],
    });
  });

  it('not enabled and no selection: no problem', async () => {
    const res = await req('GET', '/callers/carol/google');
    expect(res.body).toEqual({ enabled: false, selection: null, consentScopes: [], notes: [] });
  });

  it('an invalid hand-edited block: selection null, the validator message as problem', async () => {
    const raw = rawConfig() as { callers: Record<string, Record<string, unknown>> };
    raw.callers.carol.google = { auth: 'user', services: { drive: 'full' } };
    writeRaw(raw);
    const res = await req('GET', '/callers/carol/google');
    const body = res.body as AdminGoogleSelection;
    expect(body.selection).toBeNull();
    expect(body.problem).toMatch(/^google\.services\.drive: "full" is not offered/);
  });

  it('reports the cross-scope notes that apply', async () => {
    const raw = rawConfig() as { callers: Record<string, Record<string, unknown>> };
    raw.callers.alice.google = { auth: 'user', services: { sheets: 'read', drive: 'file' } };
    writeRaw(raw);
    const res = await req('GET', '/callers/alice/google');
    const body = res.body as AdminGoogleSelection;
    expect(body.notes).toEqual([loadGoogleCatalog().crossScopeNotes[0].text]);
    expect(body.problem).toBeUndefined();
  });

  it.each(['nobody', '__proto__', 'constructor', 'hasOwnProperty'])('404 for %s', async (alias) => {
    const res = await req('GET', `/callers/${alias}/google`);
    expect(res.status).toBe(404);
  });
});

describe('PUT /callers/:alias/google', () => {
  const valid = { auth: 'user', services: { sheets: 'edit', drive: 'read' } };

  it('writes only callers.<alias>.google; the rest of the file is byte-identical', async () => {
    const before = fs.readFileSync(getRemoteConfigPath(), 'utf8');
    const res = await req('PUT', '/callers/alice/google', valid);
    expect(res.status).toBe(200);
    const after = fs.readFileSync(getRemoteConfigPath(), 'utf8');
    expect(withoutGoogle(after, 'alice')).toBe(before);
    // Stored in catalog order, as validated.
    const stored = (readRaw().callers as Record<string, Record<string, unknown>>).alice.google;
    expect(stored).toEqual({ auth: 'user', services: { drive: 'read', sheets: 'edit' } });
    expect(Object.keys((stored as { services: object }).services)).toEqual(['drive', 'sheets']);
    // Defaults the loader merges in are not written back.
    expect(after).toContain('"$comment": "kept verbatim"');
  });

  it('keeps the file mode at 0600', async () => {
    fs.chmodSync(getRemoteConfigPath(), 0o600);
    await req('PUT', '/callers/alice/google', valid);
    expect(fs.statSync(getRemoteConfigPath()).mode & 0o777).toBe(0o600);
  });

  it('replacing an existing block changes only that block', async () => {
    const before = fs.readFileSync(getRemoteConfigPath(), 'utf8');
    const res = await req('PUT', '/callers/bob/google', {
      auth: 'service-account',
      services: { calendar: 'read' },
    });
    expect(res.status).toBe(200);
    const after = fs.readFileSync(getRemoteConfigPath(), 'utf8');
    expect(withoutGoogle(after, 'bob')).toBe(withoutGoogle(before, 'bob'));
    expect(after).not.toContain(SUBJECT);
  });

  it('returns the GET shape, refreshes the caller, and audits without the subject', async () => {
    const res = await req('PUT', '/callers/bob/google', {
      auth: 'service-account',
      subject: 'new-subject@example.com',
      services: { gmail: 'read', sheets: 'edit' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toEqual({
      enabled: true,
      selection: {
        auth: 'service-account',
        subject: 'new-subject@example.com',
        services: { gmail: 'read', sheets: 'edit' },
      },
      consentScopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/spreadsheets',
      ],
      notes: [],
    });
    expect(refreshed).toEqual(['bob']);
    expect(audited).toEqual([
      {
        action: 'google_selection',
        details: {
          caller: 'bob',
          before: { auth: 'service-account', services: { gmail: 'read' }, subjectSet: true },
          after: {
            auth: 'service-account',
            services: { gmail: 'read', sheets: 'edit' },
            subjectSet: true,
          },
        },
      },
    ]);
    const auditText = JSON.stringify(audited);
    expect(auditText).not.toContain(SUBJECT);
    expect(auditText).not.toContain('new-subject@example.com');
  });

  it('a caller without a block audits before: null', async () => {
    await req('PUT', '/callers/alice/google', valid);
    expect(audited[0].details?.before).toBeNull();
    expect(audited[0].details?.after).toEqual({
      auth: 'user',
      services: { drive: 'read', sheets: 'edit' },
      subjectSet: false,
    });
  });

  // One case per validator message (plans/google-unified.md, "Validation rules").
  const invalid: [string, unknown][] = [
    ['not an object', ['user']],
    ['unknown field', { auth: 'user', services: { sheets: 'edit' }, scopes: ['x'] }],
    ['auth missing', { services: { sheets: 'edit' } }],
    ['auth other', { auth: 'robot', services: { sheets: 'edit' } }],
    ['services missing', { auth: 'user' }],
    ['services empty', { auth: 'user', services: {} }],
    ['unknown service', { auth: 'user', services: { tasks: 'read' } }],
    [
      'prototype service',
      { auth: 'user', services: JSON.parse('{"__proto__":"read"}') as unknown },
    ],
    ['constructor service', { auth: 'user', services: { constructor: 'read' } }],
    ['drive full', { auth: 'user', services: { drive: 'full' } }],
    ['unknown level', { auth: 'user', services: { sheets: 'admin' } }],
    ['non-string level', { auth: 'user', services: { sheets: 1 } }],
    ['level not in mode', { auth: 'service-account', services: { drive: 'file' } }],
    [
      'subject in user mode',
      { auth: 'user', subject: 'a@example.com', services: { docs: 'edit' } },
    ],
    [
      'subject not an email',
      { auth: 'service-account', subject: 'alice', services: { docs: 'edit' } },
    ],
    ['gmail without subject', { auth: 'service-account', services: { gmail: 'read' } }],
  ];

  it.each(invalid)('400 with the validator message: %s', async (_name, body) => {
    const before = fs.readFileSync(getRemoteConfigPath(), 'utf8');
    let expected = '';
    try {
      validateGoogleSelection(body);
    } catch (err) {
      expected = (err as Error).message;
    }
    expect(expected).not.toBe('');
    const res = await req('PUT', '/callers/alice/google', body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expected });
    expect(fs.readFileSync(getRemoteConfigPath(), 'utf8')).toBe(before);
    expect(audited).toEqual([]);
    expect(refreshed).toEqual([]);
  });

  it.each(['nobody', '__proto__', 'constructor', 'toString'])(
    '404 for %s, and nothing is written',
    async (alias) => {
      const before = fs.readFileSync(getRemoteConfigPath(), 'utf8');
      const res = await req('PUT', `/callers/${alias}/google`, valid);
      expect(res.status).toBe(404);
      expect(fs.readFileSync(getRemoteConfigPath(), 'utf8')).toBe(before);
      expect(({} as Record<string, unknown>).google).toBeUndefined();
      expect(audited).toEqual([]);
    },
  );

  it('does not enable the connection', async () => {
    const res = await req('PUT', '/callers/carol/google', valid);
    expect((res.body as AdminGoogleSelection).enabled).toBe(false);
    const carol = (readRaw().callers as Record<string, { connections: string[] }>).carol;
    expect(carol.connections).toEqual([]);
  });
});

describe('DELETE /callers/:alias/google', () => {
  it('removes only the block; still enabled → problem', async () => {
    const before = fs.readFileSync(getRemoteConfigPath(), 'utf8');
    const res = await req('DELETE', '/callers/bob/google');
    expect(res.status).toBe(200);
    const after = fs.readFileSync(getRemoteConfigPath(), 'utf8');
    expect(after).toBe(withoutGoogle(before, 'bob'));
    const body = res.body as AdminGoogleSelection;
    expect(body.selection).toBeNull();
    expect(body.enabled).toBe(true);
    expect(body.problem).toContain('needs callers.bob.google');
    expect(refreshed).toEqual(['bob']);
    expect(audited).toEqual([
      {
        action: 'google_selection',
        details: {
          caller: 'bob',
          before: { auth: 'service-account', services: { gmail: 'read' }, subjectSet: true },
          after: null,
        },
      },
    ]);
  });

  it('no block: 200, the file untouched, no audit line', async () => {
    const before = fs.readFileSync(getRemoteConfigPath(), 'utf8');
    const res = await req('DELETE', '/callers/carol/google');
    expect(res.status).toBe(200);
    expect(fs.readFileSync(getRemoteConfigPath(), 'utf8')).toBe(before);
    expect(audited).toEqual([]);
  });

  it.each(['nobody', '__proto__', 'constructor'])('404 for %s', async (alias) => {
    const res = await req('DELETE', `/callers/${alias}/google`);
    expect(res.status).toBe(404);
  });
});

describe('the routes sit behind requireAuth', () => {
  afterEach(() => {
    delete process.env.AUTH_PASSWORD_HASH;
    delete process.env.AUTH_PASSWORD_SALT;
  });

  it('401 without a session', async () => {
    const salt = generateSalt();
    process.env.AUTH_PASSWORD_SALT = salt;
    process.env.AUTH_PASSWORD_HASH = await hashPassword('fake-admin-pass', salt);
    const cfg: RemoteServerConfig = loadRemoteConfig();
    const app = createApp({
      config: cfg,
      ownKeys: generateKeyBundle(),
      authorizedPeers: [],
      ingestorManager: new IngestorManager(cfg),
      disableRateLimiting: true,
    });
    const s = app.listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    const port = (s.address() as AddressInfo).port;
    try {
      for (const [method, p] of [
        ['GET', '/google/catalog'],
        ['GET', '/callers/bob/google'],
        ['PUT', '/callers/bob/google'],
        ['DELETE', '/callers/bob/google'],
      ]) {
        const res = await fetch(`http://127.0.0.1:${port}/api/admin${p}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(method === 'PUT' && { body: JSON.stringify({ auth: 'user', services: {} }) }),
        });
        expect(res.status, `${method} ${p}`).toBe(401);
      }
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
    expect(fs.readFileSync(getRemoteConfigPath(), 'utf8')).toContain(SUBJECT);
  });
});

describe('the selection never goes through a tool', () => {
  const src = (f: string) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');

  it('admin-google.ts does not reach dispatchTool or toolHandlers', () => {
    const text = src('./admin-google.ts');
    expect(text).not.toMatch(/from '\.\/tool-dispatch\.js'/);
    expect(text).not.toMatch(/\bdispatchTool\(/);
  });

  it('no tool module imports the admin Google routes', () => {
    expect(src('./tool-dispatch.ts')).not.toContain('admin-google');
  });
});
