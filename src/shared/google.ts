/**
 * The built-in `google` connection: one credential per caller, with the
 * services and levels chosen per caller in `callers.<alias>.google`.
 *
 * The catalog (`src/connections/google-catalog.json`) maps each service and
 * level to its scopes, allowlist and test request. Its entries were moved
 * verbatim from the per-scope `google-*` templates it replaces. It sits at the
 * top level of `src/connections/`, which the template index never reads, so it
 * is never a template itself.
 *
 * See plans/google-unified.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  GoogleAuthMode,
  GoogleServiceId,
  OAuth2SecretRefs,
  TestConnectionConfig,
} from './config.js';

/** Catalog order. Composition walks services in this order, whatever the
 *  key order of a caller's selection. */
export const GOOGLE_SERVICE_IDS: readonly GoogleServiceId[] = [
  'gmail',
  'calendar',
  'drive',
  'sheets',
  'docs',
  'slides',
];

export const GOOGLE_AUTH_MODES: readonly GoogleAuthMode[] = ['user', 'service-account'];

/** One level of one service: alternatives within a service, not a ladder. */
export interface GoogleLevel {
  /** One line on what the level reaches. Feeds the composed description. */
  summary: string;
  /** The level grants no writes through its own API. Drives the
   *  cross-service scope audit (google-catalog.test.ts). */
  readOnly: boolean;
  scopes: string[];
  /** Auth modes the level is offered in. */
  auth: GoogleAuthMode[];
  /** Service-account mode only: the level needs `google.subject`. */
  subjectRequired?: boolean;
  allowedEndpoints: string[];
  testConnection: TestConnectionConfig;
}

export interface GoogleService {
  name: string;
  docsUrl: string;
  /** The API's name in the Google Cloud console's API library. */
  enableApi: string;
  levels: Record<string, GoogleLevel>;
}

export interface GoogleAuthModeConfig {
  grant: 'refresh_token' | 'jwt_bearer';
  clientAuth?: 'body';
  secretRefs: OAuth2SecretRefs;
}

/** What each API's methods accept, limited to scopes the catalog offers. */
export interface GoogleApiAccepts {
  /** Discovery document revision the lists were taken from. */
  revision: string;
  read: string[];
  write: string[];
  note?: string;
}

export interface GoogleCrossScopeNote {
  /** service → level. The note applies when the selection contains all of them. */
  when: Partial<Record<GoogleServiceId, string>>;
  text: string;
}

export interface GoogleCatalog {
  tokenUrl: string;
  auth: Record<GoogleAuthMode, GoogleAuthModeConfig>;
  services: Record<GoogleServiceId, GoogleService>;
  apiAccepts: Record<GoogleServiceId, GoogleApiAccepts>;
  crossScopeNotes: GoogleCrossScopeNote[];
}

const CATALOG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'connections',
  'google-catalog.json',
);

let cached: GoogleCatalog | undefined;

/** Read, validate and cache the catalog. An invalid catalog throws. */
export function loadGoogleCatalog(): GoogleCatalog {
  if (cached) return cached;
  const raw: unknown = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
  validateGoogleCatalog(raw);
  cached = deepFreeze(raw);
  return cached;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// ── Catalog shape validation ──────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function fail(where: string, what: string): never {
  throw new Error(`google-catalog.json: ${where} ${what}`);
}

function onlyKeys(v: Obj, where: string, allowed: string[]): void {
  for (const key of Object.keys(v)) {
    if (!allowed.includes(key)) fail(where, `has unknown field "${key}"`);
  }
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string' || v === '') fail(where, 'must be a non-empty string');
  return v;
}

function strArray(v: unknown, where: string, nonEmpty: boolean): string[] {
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && s !== '')) {
    fail(where, 'must be an array of non-empty strings');
  }
  if (nonEmpty && v.length === 0) fail(where, 'must not be empty');
  if (new Set(v).size !== v.length) fail(where, 'has duplicates');
  return v as string[];
}

/**
 * Check the catalog's shape: every service present, every level with scopes,
 * an allowlist and a test, `auth` a non-empty subset of the two modes, and so
 * on. Shipped data, so a failure here is a bug in the catalog.
 */
export function validateGoogleCatalog(raw: unknown): asserts raw is GoogleCatalog {
  if (!isObj(raw)) fail('root', 'must be an object');
  onlyKeys(raw, 'root', ['tokenUrl', 'auth', 'services', 'apiAccepts', 'crossScopeNotes']);
  str(raw.tokenUrl, 'tokenUrl');

  if (!isObj(raw.auth)) fail('auth', 'must be an object');
  onlyKeys(raw.auth, 'auth', [...GOOGLE_AUTH_MODES]);
  for (const mode of GOOGLE_AUTH_MODES) {
    const m = raw.auth[mode];
    if (!isObj(m)) fail(`auth.${mode}`, 'must be an object');
    onlyKeys(m, `auth.${mode}`, ['grant', 'clientAuth', 'secretRefs']);
    const grant = mode === 'user' ? 'refresh_token' : 'jwt_bearer';
    if (m.grant !== grant) fail(`auth.${mode}.grant`, `must be "${grant}"`);
    if (mode === 'user' ? m.clientAuth !== 'body' : m.clientAuth !== undefined) {
      fail(`auth.${mode}.clientAuth`, mode === 'user' ? 'must be "body"' : 'must be absent');
    }
    if (!isObj(m.secretRefs)) fail(`auth.${mode}.secretRefs`, 'must be an object');
    const refs =
      mode === 'user' ? ['clientId', 'clientSecret', 'refreshToken'] : ['serviceAccountKey'];
    onlyKeys(m.secretRefs, `auth.${mode}.secretRefs`, refs);
    for (const ref of refs) str(m.secretRefs[ref], `auth.${mode}.secretRefs.${ref}`);
  }

  for (const section of ['services', 'apiAccepts'] as const) {
    const v = raw[section];
    if (!isObj(v)) fail(section, 'must be an object');
    const keys = Object.keys(v);
    if (keys.join() !== GOOGLE_SERVICE_IDS.join()) {
      fail(section, `must list exactly ${GOOGLE_SERVICE_IDS.join(', ')}, in that order`);
    }
  }
  const services = raw.services as Obj;
  for (const id of GOOGLE_SERVICE_IDS) {
    const where = `services.${id}`;
    const svc = services[id];
    if (!isObj(svc)) fail(where, 'must be an object');
    onlyKeys(svc, where, ['name', 'docsUrl', 'enableApi', 'levels']);
    str(svc.name, `${where}.name`);
    str(svc.docsUrl, `${where}.docsUrl`);
    str(svc.enableApi, `${where}.enableApi`);
    if (!isObj(svc.levels) || Object.keys(svc.levels).length === 0) {
      fail(`${where}.levels`, 'must name at least one level');
    }
    for (const [levelId, level] of Object.entries(svc.levels)) {
      const lw = `${where}.levels.${levelId}`;
      if (!/^[a-z]+$/.test(levelId)) fail(lw, 'id must be lowercase letters');
      if (!isObj(level)) fail(lw, 'must be an object');
      onlyKeys(level, lw, [
        'summary',
        'readOnly',
        'scopes',
        'auth',
        'subjectRequired',
        'allowedEndpoints',
        'testConnection',
      ]);
      str(level.summary, `${lw}.summary`);
      if (typeof level.readOnly !== 'boolean') fail(`${lw}.readOnly`, 'must be a boolean');
      strArray(level.scopes, `${lw}.scopes`, true);
      const auth = strArray(level.auth, `${lw}.auth`, true);
      for (const mode of auth) {
        if (!(GOOGLE_AUTH_MODES as string[]).includes(mode)) {
          fail(`${lw}.auth`, `has unknown mode "${mode}"`);
        }
      }
      if (level.subjectRequired !== undefined) {
        if (level.subjectRequired !== true) fail(`${lw}.subjectRequired`, 'must be true or absent');
        if (!auth.includes('service-account')) {
          fail(`${lw}.subjectRequired`, 'needs the service-account mode');
        }
      }
      strArray(level.allowedEndpoints, `${lw}.allowedEndpoints`, true);
      const test = level.testConnection;
      if (!isObj(test)) fail(`${lw}.testConnection`, 'must be an object');
      onlyKeys(test, `${lw}.testConnection`, [
        'method',
        'url',
        'headers',
        'body',
        'description',
        'expectedStatus',
      ]);
      str(test.url, `${lw}.testConnection.url`);
      str(test.description, `${lw}.testConnection.description`);
    }
  }
  const accepts = raw.apiAccepts as Obj;
  for (const id of GOOGLE_SERVICE_IDS) {
    const where = `apiAccepts.${id}`;
    const a = accepts[id];
    if (!isObj(a)) fail(where, 'must be an object');
    onlyKeys(a, where, ['revision', 'read', 'write', 'note']);
    str(a.revision, `${where}.revision`);
    strArray(a.read, `${where}.read`, true);
    strArray(a.write, `${where}.write`, false);
    if (a.note !== undefined) str(a.note, `${where}.note`);
  }
  if (!Array.isArray(raw.crossScopeNotes)) fail('crossScopeNotes', 'must be an array');
  raw.crossScopeNotes.forEach((note: unknown, i) => {
    const where = `crossScopeNotes[${i}]`;
    if (!isObj(note)) fail(where, 'must be an object');
    onlyKeys(note, where, ['when', 'text']);
    str(note.text, `${where}.text`);
    if (!isObj(note.when) || Object.keys(note.when).length < 2) {
      fail(`${where}.when`, 'must name at least two services');
    }
    for (const [svc, level] of Object.entries(note.when)) {
      const service = services[svc];
      const levels = isObj(service) ? service.levels : undefined;
      if (typeof level !== 'string' || !isObj(levels) || !Object.hasOwn(levels, level)) {
        fail(`${where}.when`, `names an unknown level ${svc}: ${JSON.stringify(level)}`);
      }
    }
  });
}
