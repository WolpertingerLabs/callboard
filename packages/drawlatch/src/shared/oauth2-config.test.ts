/**
 * OAuth2 route schema: validation, template introspection, per-caller
 * `oauth2Overrides` (narrow-only), and withholding of the oauth2 credentials.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';

import {
  resolveCallerRoutes,
  resolveCallerRoutesChecked,
  resolveRoutes,
  signerOnlySecretNames,
  substitutableSecrets,
  templateSecrets,
  validateRemoteConfig,
  connectionOverlapWarnings,
  withheldSecretValues,
  type OAuth2Config,
  type RemoteServerConfig,
  type Route,
} from './config.js';
import {
  _resetConnectionIndex,
  describeConnectionTemplate,
  listConnectionTemplates,
  loadConnection,
  validateOAuth2Config,
  validateOAuth2Route,
} from './connections.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual.default } };
});

function oauth2(overrides: Partial<OAuth2Config> = {}): OAuth2Config {
  return {
    tokenUrl: 'https://auth.example.com/oauth/token',
    grant: 'refresh_token',
    clientAuth: 'body',
    secretRefs: {
      clientId: 'EX_CLIENT_ID',
      clientSecret: 'EX_CLIENT_SECRET',
      refreshToken: 'EX_RT',
    },
    scopes: ['read', 'write'],
    ...overrides,
  };
}

function route(overrides: Partial<Route> = {}): Route {
  return {
    alias: 'example',
    allowedEndpoints: ['https://api.example.com/**'],
    secrets: {
      EX_CLIENT_ID: '${EX_CLIENT_ID}',
      EX_CLIENT_SECRET: '${EX_CLIENT_SECRET}',
      EX_RT: '${EX_RT}',
      EX_REGION: 'eu',
    },
    oauth2: oauth2(),
    ...overrides,
  };
}

describe('validateOAuth2Config', () => {
  it('accepts both supported grants', () => {
    expect(() => validateOAuth2Config(oauth2())).not.toThrow();
    expect(() =>
      validateOAuth2Config(
        oauth2({
          grant: 'client_credentials',
          clientAuth: 'basic',
          secretRefs: { clientId: 'A', clientSecret: 'B' },
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['not an object', null, 'must be an object'],
    ['unknown field', { ...oauth2(), responseMapping: {} }, 'unknown field "responseMapping"'],
    ['missing tokenUrl', { ...oauth2(), tokenUrl: '' }, 'tokenUrl is required'],
    ['bad tokenUrl', { ...oauth2(), tokenUrl: 'not a url' }, 'not a valid URL'],
    ['http tokenUrl', { ...oauth2(), tokenUrl: 'http://auth.example.com/t' }, 'must be https'],
    [
      'tokenUrl with credentials',
      { ...oauth2(), tokenUrl: 'https://u:p@auth.example.com/t' },
      'credentials',
    ],
    ['an unknown grant', { ...oauth2(), grant: 'implicit' }, 'grant must be'],
    ['bad clientAuth', { ...oauth2(), clientAuth: 'header' }, 'clientAuth must be'],
    ['no secretRefs', { ...oauth2(), secretRefs: undefined }, 'secretRefs is required'],
    [
      'unknown secretRef',
      { ...oauth2(), secretRefs: { ...oauth2().secretRefs, privateKey: 'K' } },
      'unknown secretRefs field',
    ],
    [
      'secretRef not a name',
      { ...oauth2(), secretRefs: { ...oauth2().secretRefs, clientId: '${X}' } },
      'must be a secret name',
    ],
    [
      'refresh_token without refreshToken',
      { ...oauth2(), secretRefs: { clientId: 'A', clientSecret: 'B' } },
      'refreshToken is required',
    ],
    [
      'client_credentials with refreshToken',
      { ...oauth2(), grant: 'client_credentials' },
      'not used by',
    ],
    ['scope with a space', { ...oauth2(), scopes: ['read write'] }, 'scopes must be'],
    ['scopes not an array', { ...oauth2(), scopes: 'read' }, 'scopes must be'],
    [
      'verifyGrantedScopes without scopes',
      { ...oauth2(), scopes: [], verifyGrantedScopes: true },
      'needs scopes',
    ],
    ['negative skew', { ...oauth2(), refreshSkewMs: -1 }, 'refreshSkewMs'],
    ['skew above an hour', { ...oauth2(), refreshSkewMs: 3_600_001 }, 'refreshSkewMs'],
  ])('rejects %s', (_label, value, message) => {
    expect(() => validateOAuth2Config(value)).toThrow(message);
  });

  it('allows http only on a loopback token host', () => {
    expect(() =>
      validateOAuth2Config(oauth2({ tokenUrl: 'http://127.0.0.1:8080/token' })),
    ).not.toThrow();
    expect(() =>
      validateOAuth2Config(oauth2({ tokenUrl: 'http://localhost/token' })),
    ).not.toThrow();
  });
});

describe('validateOAuth2Route', () => {
  it('accepts a well-formed route', () => {
    expect(() => validateOAuth2Route(route())).not.toThrow();
  });

  it.each([
    ['a secretRef missing from secrets', { secrets: { EX_CLIENT_ID: 'x', EX_RT: 'y' } }, 'not in'],
    ['an Authorization header', { headers: { authorization: 'Bearer ${EX_RT}' } }, 'Authorization'],
    [
      'a header referencing a credential',
      { headers: { 'X-Client': '${EX_CLIENT_ID}' } },
      'X-Client',
    ],
    ['awsSigV4', { awsSigV4: {} }, 'awsSigV4'],
    ['resolveSecretsInBody', { resolveSecretsInBody: true }, 'resolveSecretsInBody'],
    [
      'an allowlist reaching the token host',
      { allowedEndpoints: ['https://api.example.com/**', 'https://auth.example.com/**'] },
      'token endpoint',
    ],
    [
      'a wildcard host covering the token host',
      { allowedEndpoints: ['https://*.example.com/**'] },
      'token endpoint',
    ],
    ['a scheme-less pattern', { allowedEndpoints: ['**'] }, 'token endpoint'],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => validateOAuth2Route(route(overrides as Partial<Route>))).toThrow(message);
  });

  it.each([
    'https://auth.example.com/api/**',
    'https://auth.example.com/2/**',
    'https://*.example.com/drive/**',
  ])('allows %s: same host as the token endpoint, but not its URL', (pattern) => {
    expect(() => validateOAuth2Route(route({ allowedEndpoints: [pattern] }))).not.toThrow();
  });

  it.each([
    'https://auth.example.com/oauth/token',
    'https://auth.example.com/oauth/*',
    'https://auth.example.com/oauth/token?**',
    'https://auth.example.com/oauth/token/**',
    'https://auth.example.com./oauth/**',
    'https://*/oauth/token',
  ])('refuses %s, which reaches the token URL', (pattern) => {
    expect(() => validateOAuth2Route(route({ allowedEndpoints: [pattern] }))).toThrow(
      'token endpoint',
    );
  });

  it('refuses a trailing-dot token host matched by a dotless pattern', () => {
    expect(() =>
      validateOAuth2Route(
        route({
          oauth2: oauth2({ tokenUrl: 'https://auth.example.com./oauth/token' }),
          allowedEndpoints: ['https://auth.example.com/oauth/**'],
        }),
      ),
    ).toThrow('token endpoint');
  });

  it.each(['webhook', 'websocket'])('refuses a %s listener', (type) => {
    expect(() =>
      validateOAuth2Route(route({ ingestor: { type } as unknown as Route['ingestor'] })),
    ).toThrow(`a ${type} listener is not supported`);
  });

  it('allows a poll listener', () => {
    expect(() =>
      validateOAuth2Route(
        route({
          ingestor: {
            type: 'poll',
            poll: { url: 'https://api.example.com/x', intervalMs: 60_000 },
          },
        }),
      ),
    ).not.toThrow();
  });

  it('allows other headers that reference non-credential secrets', () => {
    expect(() =>
      validateOAuth2Route(route({ headers: { 'X-Region': '${EX_REGION}' } })),
    ).not.toThrow();
  });
});

describe('templates', () => {
  beforeEach(() => _resetConnectionIndex());
  afterEach(() => {
    vi.restoreAllMocks();
    _resetConnectionIndex();
  });

  it('every built-in template with an oauth2 block validates', () => {
    for (const info of listConnectionTemplates()) {
      if (info.auth) expect(() => loadConnection(info.alias)).not.toThrow();
    }
  });

  it('loadConnection rejects a template with an invalid oauth2 block', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockImplementation(((
      _p: unknown,
      opts?: { withFileTypes?: boolean },
    ) =>
      opts?.withFileTypes
        ? [{ name: 'cat', isDirectory: () => true }]
        : ['bad-oauth.json']) as unknown as typeof fs.readdirSync);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify(route({ oauth2: { ...oauth2(), grant: 'implicit' as never } })),
    );
    expect(() => loadConnection('bad-oauth')).toThrow(/bad-oauth.*grant must be/);
  });

  it('reports secretRefs as required and the auth shape, names only', () => {
    const info = describeConnectionTemplate('example', route());
    expect(info.requiredSecrets.sort()).toEqual(['EX_CLIENT_ID', 'EX_CLIENT_SECRET', 'EX_RT']);
    expect(info.optionalSecrets).toEqual(['EX_REGION']);
    expect(info.auth).toEqual({
      type: 'oauth2',
      grant: 'refresh_token',
      scopes: ['read', 'write'],
    });
  });

  it('has no auth field for a static-header template', () => {
    const info = describeConnectionTemplate('example', route({ oauth2: undefined }));
    expect(info.auth).toBeUndefined();
  });
});

describe('oauth2Overrides', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errSpy.mockRestore());

  function config(overrides?: Record<string, unknown>, connectorPatch: Partial<Route> = {}) {
    return {
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      connectors: [route(connectorPatch), { alias: 'plain', allowedEndpoints: ['https://p/**'] }],
      callers: {
        alice: {
          connections: ['example', 'plain'],
          ...(overrides && { oauth2Overrides: overrides }),
        },
      },
    } as RemoteServerConfig;
  }

  it('narrows the scopes and computes sorted effectiveScopes', () => {
    const routes = resolveCallerRoutes(config({ example: { scopes: ['read'] } }), 'alice');
    expect(routes.map((r) => r.alias)).toEqual(['example', 'plain']);
    expect(routes[0].oauth2?.scopes).toEqual(['read']);
    const [resolved] = resolveRoutes(routes, {}, 'alice');
    expect(resolved.oauth2?.effectiveScopes).toEqual(['read']);
  });

  it('effectiveScopes without an override are the route scopes, sorted and de-duplicated', () => {
    const routes = resolveCallerRoutes(
      config(undefined, { oauth2: oauth2({ scopes: ['w', 'r', 'w'] }) }),
      'alice',
    );
    expect(resolveRoutes(routes, {}, 'alice')[0].oauth2?.effectiveScopes).toEqual(['r', 'w']);
  });

  it.each([
    ['a scope outside the route', { example: { scopes: ['read', 'admin'] } }, 'admin'],
    ['an empty scope list', { example: { scopes: [] } }, 'non-empty'],
    ['a non-object entry', { example: 'read' }, 'must be an object'],
    ['an unknown field', { example: { audience: 'x' } }, 'unknown field "audience"'],
    [
      'a subject on a non-jwt_bearer route',
      { example: { subject: 'ceo@example.com' } },
      "only used by the 'jwt_bearer' grant",
    ],
    ['a route without oauth2', { plain: { scopes: ['read'] } }, 'no oauth2 block'],
  ])('drops only that connection for %s', (_label, overrides, message) => {
    const { routes, problems } = resolveCallerRoutesChecked(config(overrides), 'alice');
    const dropped = Object.keys(overrides)[0];
    expect(routes.map((r) => r.alias)).not.toContain(dropped);
    expect(routes).toHaveLength(1);
    expect(problems.join('\n')).toContain(message);
  });

  it('warns about an override for a connection the caller does not have', () => {
    const { routes, problems } = resolveCallerRoutesChecked(
      config({ ghost: { scopes: ['read'] } }),
      'alice',
    );
    expect(routes).toHaveLength(2);
    expect(problems.join('\n')).toContain('ghost');
  });

  it('drops a custom connector whose oauth2 block is invalid', () => {
    const { routes, problems } = resolveCallerRoutesChecked(
      config(undefined, { headers: { Authorization: 'Bearer x' } }),
      'alice',
    );
    expect(routes.map((r) => r.alias)).toEqual(['plain']);
    expect(problems.join('\n')).toContain('Authorization');
  });

  it('validateRemoteConfig collects problems across callers', () => {
    expect(validateRemoteConfig(config({ example: { scopes: ['nope'] } }))).toHaveLength(1);
    expect(validateRemoteConfig(config())).toEqual([]);
  });

  it('resolveCallerRoutes logs each problem once', () => {
    const cfg = config({ example: { scopes: ['once-only'] } });
    resolveCallerRoutes(cfg, 'alice');
    resolveCallerRoutes(cfg, 'alice');
    const logged = errSpy.mock.calls.flat().filter((m) => String(m).includes('once-only'));
    expect(logged).toHaveLength(1);
  });
});

describe('oauth2 credentials are signer-only', () => {
  const SECRETS = {
    EX_CLIENT_ID: 'client-id-value-1234',
    EX_CLIENT_SECRET: 'client-secret-value-5678',
    EX_RT: 'refresh-token-value-9012',
    EX_REGION: 'eu-west',
    WRAPS_RT: 'prefix-refresh-token-value-9012',
  };

  function resolved(patch: Partial<Route> = {}) {
    const [r] = resolveRoutes(
      [route({ secrets: { ...SECRETS }, headers: { 'X-Region': '${EX_REGION}' }, ...patch })],
      {},
      'alice',
    );
    return r;
  }

  it('signerOnlySecretNames lists every secretRef', () => {
    expect([...signerOnlySecretNames(route())].sort()).toEqual([
      'EX_CLIENT_ID',
      'EX_CLIENT_SECRET',
      'EX_RT',
    ]);
  });

  it('withholds them (and any value containing one) from callers and templates', () => {
    const r = resolved();
    // EX_REGION is in a route header (tier 2), so nothing is substitutable.
    expect(Object.keys(substitutableSecrets(r))).toEqual([]);
    expect(Object.keys(templateSecrets(r))).toEqual(['EX_REGION']);
    expect(r.withheldSecrets.sort()).toEqual(
      ['EX_CLIENT_ID', 'EX_CLIENT_SECRET', 'EX_REGION', 'EX_RT'].sort(),
    );
    // Scrubbed from bodies, including the containing value.
    expect(Object.keys(withheldSecretValues(r)).sort()).toEqual(
      ['EX_CLIENT_ID', 'EX_CLIENT_SECRET', 'EX_REGION', 'EX_RT', 'WRAPS_RT'].sort(),
    );
  });

  it('never resolves them into route headers', () => {
    // validateOAuth2Route forbids this; resolveRoutes still refuses on its own.
    const r = resolved({ headers: { 'X-Leak': '${EX_CLIENT_SECRET}' } });
    expect(r.headers['X-Leak']).toBe('${EX_CLIENT_SECRET}');
  });
});

describe('oauth2Overrides lookup', () => {
  it('ignores inherited keys such as constructor', () => {
    const config = {
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      connectors: [{ ...route(), alias: 'constructor' }],
      callers: { alice: { connections: ['constructor'], oauth2Overrides: {} } },
    } as RemoteServerConfig;
    const { routes, problems } = resolveCallerRoutesChecked(config, 'alice');
    // Without an own-property lookup, Object.prototype.constructor would be
    // taken as the override and the connection dropped as malformed.
    expect(problems).toEqual([]);
    expect(routes.map((r) => r.alias)).toEqual(['constructor']);
  });
});

describe('connectionOverlapWarnings', () => {
  const cfg = (connections: string[], connectors: Route[] = []): RemoteServerConfig => ({
    host: '127.0.0.1',
    port: 0,
    rateLimitPerMinute: 60,
    connectors,
    callers: { alice: { connections } },
  });

  it('is quiet for every built-in template together, but one of each overlapping pair', () => {
    // Alternatives for one API overlap by design: keep one of each. The
    // composed google route, every service selected, shares
    // www.googleapis.com between Calendar and Drive but not paths.
    const alternatives = new Set(['discord-oauth']);
    const all = listConnectionTemplates()
      .map((t) => t.alias)
      .filter((alias) => !alternatives.has(alias));
    expect(all).toContain('google');
    const config = cfg(all);
    config.callers.alice.google = {
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
    expect(connectionOverlapWarnings(config)).toEqual([]);
  });

  it('flags discord-bot with discord-oauth (two auth modes for one API)', () => {
    const [warning] = connectionOverlapWarnings(cfg(['discord-bot', 'discord-oauth']));
    expect(warning).toContain('"discord-bot" and "discord-oauth"');
  });

  it('flags a wildcard host overlapping an exact one, and says OAuth2 requests are refused', () => {
    const warnings = connectionOverlapWarnings(
      cfg(
        ['example', 'wide'],
        [route(), { alias: 'wide', allowedEndpoints: ['https://*.example.com/v2/**'] }],
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('refused (OAuth2)');
  });

  it('treats a pattern without a host as overlapping everything', () => {
    const warnings = connectionOverlapWarnings(
      cfg(['github', 'any'], [{ alias: 'any', allowedEndpoints: ['**'] }]),
    );
    expect(warnings).toHaveLength(1);
  });
});

// ── jwt_bearer (service accounts) ─────────────────────────────────────────

function sa(overrides: Partial<OAuth2Config> = {}): OAuth2Config {
  return {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    grant: 'jwt_bearer',
    secretRefs: { serviceAccountKey: 'SA_KEY' },
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    ...overrides,
  };
}

function saRoute(overrides: Partial<Route> = {}): Route {
  return {
    alias: 'gsa',
    allowedEndpoints: ['https://www.googleapis.com/drive/v3/files**'],
    secrets: { SA_KEY: '${SA_KEY}' },
    oauth2: sa(),
    ...overrides,
  };
}

describe('jwt_bearer validation', () => {
  it('accepts a service-account block, with or without subject/subjectRequired', () => {
    expect(() => validateOAuth2Config(sa())).not.toThrow();
    expect(() => validateOAuth2Config(sa({ subjectRequired: true }))).not.toThrow();
    expect(() => validateOAuth2Config(sa({ subject: 'ceo@example.com' }))).not.toThrow();
  });

  it.each([
    ['clientAuth', sa({ clientAuth: 'body' }), 'clientAuth is not used'],
    ['no serviceAccountKey', sa({ secretRefs: {} }), 'serviceAccountKey is required'],
    [
      'a clientId',
      sa({ secretRefs: { serviceAccountKey: 'K', clientId: 'C' } }),
      'clientId is not used',
    ],
    [
      'a refreshToken',
      sa({ secretRefs: { serviceAccountKey: 'K', refreshToken: 'R' } }),
      'refreshToken is not used',
    ],
    ['no scopes', sa({ scopes: undefined }), 'scopes are required'],
    ['empty scopes', sa({ scopes: [] }), 'scopes are required'],
    ['a non-email subject', sa({ subject: 'ceo' }), 'subject must be an email'],
    ['a subject with whitespace', sa({ subject: 'c eo@example.com' }), 'subject must be'],
    ['a subject with a newline', sa({ subject: 'ceo@example.com\nX: y' }), 'subject must be'],
    ['a non-boolean subjectRequired', sa({ subjectRequired: 'yes' as never }), 'boolean'],
  ])('rejects %s', (_label, value, message) => {
    expect(() => validateOAuth2Config(value)).toThrow(message);
  });

  it.each([
    [
      'serviceAccountKey',
      oauth2({ secretRefs: { ...oauth2().secretRefs, serviceAccountKey: 'K' } }),
    ],
    ['subject', oauth2({ subject: 'ceo@example.com' })],
    ['subjectRequired', oauth2({ subjectRequired: true })],
  ])('rejects %s on a refresh_token grant', (_label, value) => {
    expect(() => validateOAuth2Config(value)).toThrow("only used by the 'jwt_bearer' grant");
  });

  it('a template may not set subject; a custom connector may', () => {
    const withSubject = saRoute({ oauth2: sa({ subject: 'ceo@example.com' }) });
    expect(() => validateOAuth2Route(withSubject, 'template')).toThrow(
      'a template may not set subject',
    );
    expect(() => validateOAuth2Route(withSubject, 'connector')).not.toThrow();
  });

  it('counts the key as a required, signer-only secret', () => {
    const info = describeConnectionTemplate(
      'gsa',
      saRoute({ oauth2: sa({ subjectRequired: true }) }),
    );
    expect(info.requiredSecrets).toEqual(['SA_KEY']);
    expect(info.auth).toEqual({
      type: 'oauth2',
      grant: 'jwt_bearer',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      subjectRequired: true,
    });
    expect([...signerOnlySecretNames(saRoute())]).toEqual(['SA_KEY']);
    const [r] = resolveRoutes([saRoute({ secrets: { SA_KEY: 'key-value-abc' } })], {}, 'alice');
    expect(Object.keys(substitutableSecrets(r))).toEqual([]);
    expect(Object.keys(templateSecrets(r))).toEqual([]);
    expect(Object.keys(withheldSecretValues(r))).toEqual(['SA_KEY']);
  });
});

describe('jwt_bearer subject (oauth2Overrides)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errSpy.mockRestore());

  function config(
    override: Record<string, unknown> | undefined,
    oauth2Patch: Partial<OAuth2Config> = {},
  ): RemoteServerConfig {
    return {
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      connectors: [saRoute({ oauth2: sa(oauth2Patch) })],
      callers: {
        alice: { connections: ['gsa'], ...(override && { oauth2Overrides: { gsa: override } }) },
      },
    } as RemoteServerConfig;
  }

  it('merges the override subject (and scopes) into the route', () => {
    const { routes, problems } = resolveCallerRoutesChecked(
      config({ subject: 'ceo@example.com' }),
      'alice',
    );
    expect(problems).toEqual([]);
    expect(routes[0].oauth2?.subject).toBe('ceo@example.com');
    const [resolved] = resolveRoutes(routes, {}, 'alice');
    expect(resolved.oauth2?.subject).toBe('ceo@example.com');
  });

  it('the override subject replaces a connector subject', () => {
    const { routes } = resolveCallerRoutesChecked(
      config({ subject: 'b@example.com' }, { subject: 'a@example.com' }),
      'alice',
    );
    expect(routes[0].oauth2?.subject).toBe('b@example.com');
  });

  it('drops a subjectRequired connection for a caller without a subject', () => {
    const { routes, problems } = resolveCallerRoutesChecked(
      config(undefined, { subjectRequired: true }),
      'alice',
    );
    expect(routes).toEqual([]);
    expect(problems.join('\n')).toMatch(/subjectRequired.*oauth2Overrides\["gsa"\]\.subject/);
    const ok = resolveCallerRoutesChecked(
      config({ subject: 'ceo@example.com' }, { subjectRequired: true }),
      'alice',
    );
    expect(ok.routes).toHaveLength(1);
  });

  it('a connector subject satisfies subjectRequired', () => {
    const { routes } = resolveCallerRoutesChecked(
      config(undefined, { subjectRequired: true, subject: 'a@example.com' }),
      'alice',
    );
    expect(routes).toHaveLength(1);
  });

  it('drops the connection for an invalid override subject', () => {
    const { routes, problems } = resolveCallerRoutesChecked(config({ subject: 'nobody' }), 'alice');
    expect(routes).toEqual([]);
    expect(problems.join('\n')).toContain('subject must be an email address');
  });

  it('applies to a jwt_bearer custom connector with subjectRequired', () => {
    const connector: Route = {
      alias: 'mailbox',
      secrets: { SA_KEY: 'x' },
      allowedEndpoints: ['https://gmail.googleapis.com/gmail/v1/users/me/**'],
      oauth2: {
        tokenUrl: 'https://oauth2.googleapis.com/token',
        grant: 'jwt_bearer',
        secretRefs: { serviceAccountKey: 'SA_KEY' },
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        subjectRequired: true,
      },
    };
    const base = {
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      connectors: [connector],
    };
    const without = resolveCallerRoutesChecked(
      { ...base, callers: { a: { connections: ['mailbox'] } } } as RemoteServerConfig,
      'a',
    );
    expect(without.routes).toEqual([]);
    const withSubject = resolveCallerRoutesChecked(
      {
        ...base,
        callers: {
          a: {
            connections: ['mailbox'],
            oauth2Overrides: { mailbox: { subject: 'me@example.com' } },
          },
        },
      } as RemoteServerConfig,
      'a',
    );
    expect(withSubject.routes.map((r) => r.alias)).toEqual(['mailbox']);
  });
});
