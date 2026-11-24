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
  CallerConfig,
  GoogleAuthMode,
  GoogleCallerConfig,
  GoogleServiceId,
  OAuth2Config,
  OAuth2SecretRefs,
  Route,
  TestConnectionConfig,
} from './config.js';
import { isValidOAuth2Subject, loadConnection } from './connections.js';

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

// ── Selection ─────────────────────────────────────────────────────────────

const SELECTION_FIELDS = ['auth', 'services', 'subject'];
/** Levels people may expect for Drive that the catalog refuses on purpose. */
const REFUSED_DRIVE_LEVELS = new Set(['full', 'edit', 'write']);

/**
 * Validate a caller's `google` block (hand-edited JSON). Returns a fresh
 * object with services in catalog order. Throws with the documented messages
 * (plans/google-unified.md, "Validation rules and messages"). Only own
 * properties are read, so `__proto__`/`constructor` never pick up
 * Object.prototype.
 */
export function validateGoogleSelection(raw: unknown): GoogleCallerConfig {
  const catalog = loadGoogleCatalog();
  if (!isObj(raw)) {
    throw new Error(
      'google must be an object: { "auth": "user" | "service-account", "services": { … } }',
    );
  }
  for (const key of Object.keys(raw)) {
    if (!SELECTION_FIELDS.includes(key)) {
      throw new Error(
        `google has unknown field "${key}" (allowed: ${SELECTION_FIELDS.join(', ')})`,
      );
    }
  }
  const auth = Object.hasOwn(raw, 'auth') ? raw.auth : undefined;
  if (auth !== 'user' && auth !== 'service-account') {
    throw new Error('google.auth must be "user" or "service-account"');
  }
  const known = GOOGLE_SERVICE_IDS.join(', ');
  const services = Object.hasOwn(raw, 'services') ? raw.services : undefined;
  if (!isObj(services) || Object.keys(services).length === 0) {
    throw new Error(`google.services must name at least one service (${known})`);
  }
  const picked = new Map<GoogleServiceId, string>();
  for (const [id, levelId] of Object.entries(services)) {
    if (!(GOOGLE_SERVICE_IDS as string[]).includes(id)) {
      throw new Error(
        `google.services: unknown service "${id}" (known: ${known}). For other Google APIs, ` +
          'define a custom connector: CONNECTIONS.md → Other Google APIs',
      );
    }
    const svc = id as GoogleServiceId;
    const levels = catalog.services[svc].levels;
    if (svc === 'drive' && typeof levelId === 'string' && REFUSED_DRIVE_LEVELS.has(levelId)) {
      throw new Error(
        `google.services.drive: "${levelId}" is not offered: the drive scope would also make ` +
          'the Sheets read level writable and reach every file. Use "read" or "file", or a ' +
          'custom connector',
      );
    }
    if (typeof levelId !== 'string' || !Object.hasOwn(levels, levelId)) {
      throw new Error(
        `google.services.${svc}: unknown level ${JSON.stringify(levelId)} ` +
          `(levels: ${Object.keys(levels).join(', ')})`,
      );
    }
    if (!levels[levelId].auth.includes(auth)) {
      const available = Object.entries(levels)
        .filter(([, l]) => l.auth.includes(auth))
        .map(([lid]) => lid);
      throw new Error(
        `google.services.${svc}: level "${levelId}" is not available with auth "${auth}" ` +
          `(available: ${available.join(', ') || 'none'})`,
      );
    }
    picked.set(svc, levelId);
  }
  let subject: string | undefined;
  if (Object.hasOwn(raw, 'subject')) {
    if (auth === 'user') throw new Error('google.subject is only used with auth "service-account"');
    if (!isValidOAuth2Subject(raw.subject)) {
      throw new Error('google.subject must be an email address');
    }
    subject = raw.subject;
  }
  if (auth === 'service-account' && subject === undefined) {
    for (const [svc, levelId] of picked) {
      if (catalog.services[svc].levels[levelId].subjectRequired) {
        throw new Error(
          `google.services.${svc} needs google.subject with auth "service-account": a service ` +
            'account has no mailbox, so it must act as a Workspace user (domain-wide delegation)',
        );
      }
    }
  }
  const ordered: Partial<Record<GoogleServiceId, string>> = {};
  for (const svc of GOOGLE_SERVICE_IDS) {
    const levelId = picked.get(svc);
    if (levelId !== undefined) ordered[svc] = levelId;
  }
  return { auth, services: ordered, ...(subject !== undefined && { subject }) };
}

interface PickedLevel {
  svc: GoogleServiceId;
  levelId: string;
  level: GoogleLevel;
}

/** The selected levels, in catalog order. Assumes a validated selection. */
function pickedLevels(sel: GoogleCallerConfig): PickedLevel[] {
  const catalog = loadGoogleCatalog();
  const out: PickedLevel[] = [];
  for (const svc of GOOGLE_SERVICE_IDS) {
    const levelId = Object.hasOwn(sel.services, svc) ? sel.services[svc] : undefined;
    if (levelId === undefined) continue;
    const level = Object.hasOwn(catalog.services[svc].levels, levelId)
      ? catalog.services[svc].levels[levelId]
      : undefined;
    if (!level) throw new Error(`google.services.${svc}: unknown level "${levelId}"`);
    out.push({ svc, levelId, level });
  }
  return out;
}

const unique = <T>(items: T[]): T[] => [...new Set(items)];

/** The scopes a selection's refresh token must be consented for: the sorted union. */
export function googleConsentScopes(sel: GoogleCallerConfig): string[] {
  return unique(pickedLevels(sel).flatMap((p) => p.level.scopes)).sort();
}

/**
 * Turn the base `google` template and a validated selection into one ordinary
 * OAuth2 route: the union of the chosen levels' scopes and allowlists, the
 * selected mode's credentials only, and one test per service.
 */
export function composeGoogleRoute(base: Route, sel: GoogleCallerConfig): Route {
  const catalog = loadGoogleCatalog();
  const mode = catalog.auth[sel.auth];
  const picked = pickedLevels(sel);
  if (picked.length === 0) throw new Error('google.services must name at least one service');

  const scopes = unique(picked.flatMap((p) => p.level.scopes));
  // Catalog order, exclusions in place. Services' patterns never overlap
  // (google-catalog.test.ts), so the order doesn't change what matches.
  const allowedEndpoints = unique(picked.flatMap((p) => p.level.allowedEndpoints));

  const secrets: Record<string, string> = {};
  for (const name of Object.values(mode.secretRefs)) {
    if (typeof name !== 'string') continue;
    const value =
      base.secrets && Object.hasOwn(base.secrets, name) ? base.secrets[name] : undefined;
    if (value === undefined) {
      throw new Error(`the base "google" template has no secret ${name}`);
    }
    secrets[name] = value;
  }

  const oauth2: OAuth2Config =
    sel.auth === 'user'
      ? {
          tokenUrl: catalog.tokenUrl,
          grant: 'refresh_token',
          clientAuth: 'body',
          secretRefs: { ...mode.secretRefs },
          scopes,
        }
      : {
          tokenUrl: catalog.tokenUrl,
          grant: 'jwt_bearer',
          secretRefs: { ...mode.secretRefs },
          scopes,
          ...(sel.subject !== undefined && { subject: sel.subject }),
        };

  const authText =
    sel.auth === 'user'
      ? 'user OAuth'
      : sel.subject !== undefined
        ? 'service account, delegated'
        : 'service account';
  const list = picked.map((p) => `${p.svc} ${p.levelId}`).join(', ');
  const details = picked.map((p) => `${p.svc} ${p.levelId}: ${p.level.summary}.`).join(' ');

  return {
    alias: 'google',
    name: 'Google',
    description: `Google (${authText}): ${list}. ${details}`,
    ...(base.docsUrl !== undefined && { docsUrl: base.docsUrl }),
    ...(base.stability !== undefined && { stability: base.stability }),
    ...(base.category !== undefined && { category: base.category }),
    secrets,
    oauth2,
    allowedEndpoints,
    testConnections: picked.map((p) => ({
      name: p.svc,
      level: p.levelId,
      ...structuredClone(p.level.testConnection),
    })),
  };
}

/**
 * One composed `google` route per auth mode, each selecting every level that
 * mode offers. For the agent-path policy gates only (tool-dispatch.ts): they
 * need the credential names of both modes, whatever a caller has selected.
 */
export function googleCredentialRoutes(base: Route = loadConnection('google')): Route[] {
  const catalog = loadGoogleCatalog();
  return GOOGLE_AUTH_MODES.map((auth) => {
    const services: Partial<Record<GoogleServiceId, string>> = {};
    for (const svc of GOOGLE_SERVICE_IDS) {
      const levelId = Object.entries(catalog.services[svc].levels).find(([, l]) =>
        l.auth.includes(auth),
      )?.[0];
      if (levelId !== undefined) services[svc] = levelId;
    }
    return composeGoogleRoute(base, {
      auth,
      services,
      ...(auth === 'service-account' && { subject: 'policy-gate@example.invalid' }),
    });
  });
}

const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';

/** The catalog level a scope belongs to, as `service: level`, or undefined. */
function levelOfScope(scope: string): string | undefined {
  const catalog = loadGoogleCatalog();
  for (const svc of GOOGLE_SERVICE_IDS) {
    for (const [levelId, level] of Object.entries(catalog.services[svc].levels)) {
      if (level.scopes.includes(scope)) return `${svc}: ${levelId}`;
    }
  }
  return undefined;
}

/**
 * A scope for a hint: `drive.readonly (drive: read)` for a catalog scope, the
 * scope itself otherwise. Scope names only.
 */
export function googleScopeLabel(scope: string): string {
  const level = levelOfScope(scope);
  const short = scope.startsWith(SCOPE_PREFIX) ? scope.slice(SCOPE_PREFIX.length) : scope;
  return level ? `${short} (${level})` : scope;
}

/** A catalog level's scopes, or undefined when `svc`/`levelId` isn't one. */
export function googleLevelScopes(svc: string, levelId: string): readonly string[] | undefined {
  const catalog = loadGoogleCatalog();
  if (!(GOOGLE_SERVICE_IDS as string[]).includes(svc)) return undefined;
  const levels = catalog.services[svc as GoogleServiceId].levels;
  return Object.hasOwn(levels, levelId) ? levels[levelId].scopes : undefined;
}

/** The catalog's cross-service scope notes that apply to a selection. */
export function googleCrossScopeNotes(sel: GoogleCallerConfig): string[] {
  return loadGoogleCatalog()
    .crossScopeNotes.filter((note) =>
      Object.entries(note.when).every(
        ([svc, level]) =>
          Object.hasOwn(sel.services, svc) && sel.services[svc as GoogleServiceId] === level,
      ),
    )
    .map((note) => note.text);
}

/**
 * Boot-time info lines: each caller with `google` enabled whose valid
 * selection matches a cross-scope note (plans/google-unified.md, Q4).
 */
export function googleBootNotes(callers: Record<string, CallerConfig>): string[] {
  const lines: string[] = [];
  for (const [alias, caller] of Object.entries(callers)) {
    if (!caller.connections.includes('google') || !Object.hasOwn(caller, 'google')) continue;
    let sel: GoogleCallerConfig;
    try {
      sel = validateGoogleSelection(caller.google);
    } catch {
      continue; // reported as a dropped connection
    }
    for (const text of googleCrossScopeNotes(sel)) lines.push(`Caller "${alias}": google: ${text}`);
  }
  return lines;
}
