/**
 * Withheld secrets and the caller self-management lock.
 *
 *   - A secret a route injects through its own `headers` is header-only: a
 *     caller can't reference it in a request URL, header, or body, where an
 *     upstream could echo it back (`File not found: ya29…`).
 *   - Header injection keeps working for those secrets.
 *   - Response bodies are scrubbed of withheld values (JSON and text, raw and
 *     URL-encoded), and only of withheld values.
 *   - Templates that put secrets in URLs or bodies on purpose (Trello, Telegram)
 *     keep working, and `placeholderSecrets` releases a header secret.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  resolveRoutes,
  substitutableSecrets,
  templateSecrets,
  withheldSecretNames,
  type ResolvedRoute,
  type Route,
} from '../shared/config.js';
import { listConnectionTemplates, loadConnection } from '../shared/connections.js';
import { dispatchTool, executeProxyRequest, type ToolContext } from './tool-dispatch.js';

const TOKEN = 'ya29.header-only-token+/=value';
const OTHER = 'plain-config-value-1234';

interface Received {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('header-only secrets in executeProxyRequest', () => {
  let server: http.Server;
  let base: string;
  let received: Received[] = [];

  beforeAll(async () => {
    // Echoes like a real upstream's error path: the last path segment, the
    // query string, the request body, and the Authorization header, in either
    // a JSON or a text body.
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        received.push({ url: req.url!, headers: req.headers, body });
        const u = new URL(req.url!, 'http://x');
        const segment = decodeURIComponent(u.pathname.split('/').pop() ?? '');
        if (u.pathname.startsWith('/text/')) {
          res.setHeader('content-type', 'text/plain');
          res.end(
            `not found: ${segment}; auth=${String(req.headers.authorization)}; ` +
              `encoded=${encodeURIComponent(TOKEN)}`,
          );
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            error: `File not found: ${segment}`,
            auth: req.headers.authorization,
            nested: [{ [TOKEN]: `x-${TOKEN}-y` }, 42, null, true],
            echoedBody: body,
            config: OTHER,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    received = [];
  });

  function routes(overrides: Partial<Route> = {}): ResolvedRoute[] {
    return resolveRoutes([
      {
        alias: 'svc',
        headers: { Authorization: 'Bearer ${API_TOKEN}' },
        secrets: { API_TOKEN: TOKEN, ACCOUNT_ID: OTHER },
        allowedEndpoints: [`${base}/**`],
        ...overrides,
      },
    ]);
  }

  it('reproduction: a header token in the URL never reaches the upstream', async () => {
    await expect(
      executeProxyRequest({ method: 'GET', url: `${base}/files/\${API_TOKEN}` }, routes()),
    ).rejects.toThrow(
      'The request URL references ${API_TOKEN}, a secret this connection withholds',
    );
    expect(received).toHaveLength(0);
  });

  it('rejects a header token in the query string', async () => {
    await expect(
      executeProxyRequest({ method: 'GET', url: `${base}/x?access_token=\${API_TOKEN}` }, routes()),
    ).rejects.toThrow('withholds');
    expect(received).toHaveLength(0);
  });

  it('rejects a header token in a client header', async () => {
    await expect(
      executeProxyRequest(
        { method: 'GET', url: `${base}/x`, headers: { 'X-Echo': '${API_TOKEN}' } },
        routes(),
      ),
    ).rejects.toThrow('Header "X-Echo" references ${API_TOKEN}');
    expect(received).toHaveLength(0);
  });

  it.each([
    ['string', 'token=${API_TOKEN}'],
    ['JSON', { token: '${API_TOKEN}' }],
  ])('rejects a header token in a %s body on a resolveSecretsInBody route', async (_k, body) => {
    await expect(
      executeProxyRequest(
        { method: 'POST', url: `${base}/x`, body },
        routes({ resolveSecretsInBody: true }),
      ),
    ).rejects.toThrow('The request body references ${API_TOKEN}');
    expect(received).toHaveLength(0);
  });

  it('rejects a header token in a multipart payload on a resolveSecretsInBody route', async () => {
    await expect(
      executeProxyRequest(
        {
          method: 'POST',
          url: `${base}/x`,
          body: { t: '${API_TOKEN}' },
          files: [{ field: 'f', data: 'aGk=', filename: 'a.txt', contentType: 'text/plain' }],
        },
        routes({ resolveSecretsInBody: true }),
      ),
    ).rejects.toThrow('withholds');
  });

  it('still injects the header-only secret through the route header', async () => {
    const result = await executeProxyRequest({ method: 'GET', url: `${base}/ok` }, routes());
    expect(result.status).toBe(200);
    expect(received[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('still substitutes a secret the headers do not reference', async () => {
    await executeProxyRequest(
      { method: 'GET', url: `${base}/acct/\${ACCOUNT_ID}?id=\${ACCOUNT_ID}` },
      routes(),
    );
    expect(received[0].url).toBe(`/acct/${OTHER}?id=${OTHER}`);
  });

  it('scrubs withheld values from JSON string leaves and keys, raw and encoded', async () => {
    const result = await executeProxyRequest(
      { method: 'POST', url: `${base}/echo`, body: `raw=${encodeURIComponent(TOKEN)}` },
      routes(),
    );
    const body = result.body as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain(encodeURIComponent(TOKEN));
    expect(body.auth).toBe('Bearer ${API_TOKEN}');
    expect(body.nested).toEqual([{ '${API_TOKEN}': 'x-${API_TOKEN}-y' }, 42, null, true]);
    expect(body.echoedBody).toBe('raw=${API_TOKEN}');
    // Non-withheld values are left alone.
    expect(body.config).toBe(OTHER);
  });

  it('still scrubs a withheld value nested past the recursion limit', async () => {
    const s = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"a":'.repeat(100) + JSON.stringify(TOKEN) + '}'.repeat(100));
    });
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    const deepBase = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const result = await executeProxyRequest(
        { method: 'GET', url: `${deepBase}/deep` },
        routes({ allowedEndpoints: [`${deepBase}/**`] }),
      );
      expect(JSON.stringify(result.body)).not.toContain(TOKEN);
      expect(JSON.stringify(result.body)).toContain('${API_TOKEN}');
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it('scrubs withheld values from a text body', async () => {
    const result = await executeProxyRequest({ method: 'GET', url: `${base}/text/abc` }, routes());
    const text = result.body as string;
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(encodeURIComponent(TOKEN));
    expect(text).toBe('not found: abc; auth=Bearer ${API_TOKEN}; encoded=${API_TOKEN}');
  });

  it('withholds a secret whose value contains a header-only value', async () => {
    const r = routes({ secrets: { API_TOKEN: TOKEN, WRAPPED: `pre-${TOKEN}` } });
    expect(Object.keys(substitutableSecrets(r[0]))).toEqual([]);
    await expect(
      executeProxyRequest({ method: 'GET', url: `${base}/\${WRAPPED}` }, r),
    ).rejects.toThrow('${WRAPPED}');
  });

  it('withholds names listed in withheldSecrets and the webhook signatureSecret', async () => {
    const r = routes({
      secrets: { API_TOKEN: TOKEN, EXTRA: 'extra-secret-value', HOOK: 'hook-secret-value' },
      withheldSecrets: ['EXTRA'],
      ingestor: { type: 'webhook', webhook: { path: 'p', signatureSecret: 'HOOK' } },
    });
    expect(r[0].withheldSecrets.sort()).toEqual(['API_TOKEN', 'EXTRA', 'HOOK']);
    for (const name of ['EXTRA', 'HOOK']) {
      await expect(
        executeProxyRequest({ method: 'GET', url: `${base}/\${${name}}` }, r),
      ).rejects.toThrow('withholds');
    }
    // Template-authored strings (listener configs) still see all three.
    expect(Object.keys(templateSecrets(r[0])).sort()).toEqual(['API_TOKEN', 'EXTRA', 'HOOK']);
  });

  it('placeholderSecrets releases a header secret for URL substitution', async () => {
    const r = routes({ placeholderSecrets: ['API_TOKEN'] });
    await executeProxyRequest({ method: 'GET', url: `${base}/q?t=\${API_TOKEN}` }, r);
    expect(received[0].url.startsWith('/q?t=')).toBe(true);
    expect(decodeURIComponent(received[0].url.slice('/q?t='.length))).toBe(TOKEN);
    expect(received[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('placeholderSecrets cannot release a SigV4 signing credential', () => {
    const names = withheldSecretNames({
      alias: 'aws',
      awsSigV4: { service: 'sts', region: 'us-east-1' },
      secrets: { AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'sk' },
      placeholderSecrets: ['AWS_SECRET_ACCESS_KEY'],
      allowedEndpoints: [],
    });
    expect(names.has('AWS_SECRET_ACCESS_KEY')).toBe(true);
  });

  it('reports withheldSecretNames in list_routes, names only', async () => {
    const [info] = (await dispatchTool('list_routes', {}, routes(), {
      callerAlias: 'x',
    } as ToolContext)) as Record<string, unknown>[];
    expect(info.withheldSecretNames).toEqual(['API_TOKEN']);
    expect(JSON.stringify(info)).not.toContain(TOKEN);
  });
});

// ── Built-in template audit ──────────────────────────────────────────────

describe('built-in templates under header-only withholding', () => {
  const templates = listConnectionTemplates().map((t) => ({
    alias: t.alias,
    route: { ...loadConnection(t.alias), alias: t.alias },
  }));

  it.each(templates)('$alias: every header secret still resolves in its header', ({ route }) => {
    const secrets = Object.fromEntries(
      Object.keys(route.secrets ?? {}).map((k) => [k, `value-of-${k}`]),
    );
    const [resolved] = resolveRoutes([{ ...route, secrets }]);
    for (const value of Object.values(resolved.headers)) {
      expect(value).not.toMatch(/\$\{\w+\}/);
    }
  });

  it.each(templates)(
    '$alias: placeholders its own description, tests, and option lookups use stay substitutable',
    ({ route }) => {
      // Strings an agent is told to send, or that drawlatch sends through
      // executeProxyRequest on the caller's behalf: test_connection,
      // test_ingestor, resolve_listener_options.
      const callerFacing = JSON.stringify([
        route.description,
        route.listenerConfig?.description,
        route.testConnection,
        route.testIngestor,
        route.listenerConfig?.fields.map((f) => f.dynamicOptions),
      ]);
      const referenced = [...callerFacing.matchAll(/\$\{(\w+)\}/g)]
        .map((m) => m[1])
        .filter((name) => name in (route.secrets ?? {}));
      const withheld = withheldSecretNames(route);
      for (const name of referenced) expect(withheld.has(name)).toBe(false);
    },
  );

  it('withholds the bearer tokens the issue names, and keeps URL-auth templates working', () => {
    const w = (alias: string) => withheldSecretNames({ ...loadConnection(alias), alias });
    expect(w('google').has('GOOGLE_API_TOKEN')).toBe(true);
    expect(w('github').has('GITHUB_TOKEN')).toBe(true);
    expect(w('github').has('GITHUB_WEBHOOK_SECRET')).toBe(true);
    expect(w('discord-oauth').has('DISCORD_OAUTH_TOKEN')).toBe(true);
    expect(w('slack').has('SLACK_BOT_TOKEN')).toBe(true);
    expect(w('stripe').has('STRIPE_WEBHOOK_SECRET')).toBe(true);
    // Query-param / path auth: must stay substitutable.
    expect(w('trello').has('TRELLO_API_KEY')).toBe(false);
    expect(w('trello').has('TRELLO_TOKEN')).toBe(false);
    expect(w('trello').has('TRELLO_API_SECRET')).toBe(true);
    expect(w('telegram').has('TELEGRAM_BOT_TOKEN')).toBe(false);
  });
});

describe('URL-auth templates still substitute through executeProxyRequest', () => {
  let server: http.Server;
  let base: string;
  let received: Received[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({
          url: req.url!,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, url: req.url }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A built-in template, pointed at the local server. */
  function template(alias: string, secrets: Record<string, string>): ResolvedRoute[] {
    received = [];
    return resolveRoutes([
      { ...loadConnection(alias), alias, secrets, allowedEndpoints: [`${base}/**`] },
    ]);
  }

  it('trello: key and token in the query string', async () => {
    const r = template('trello', { TRELLO_API_KEY: 'trello-key-1', TRELLO_TOKEN: 'trello-tok-1' });
    const res = await executeProxyRequest(
      { method: 'GET', url: `${base}/1/members/me?key=\${TRELLO_API_KEY}&token=\${TRELLO_TOKEN}` },
      r,
    );
    expect(received[0].url).toBe('/1/members/me?key=trello-key-1&token=trello-tok-1');
    // Substitutable secrets are not scrubbed from the body: they're the
    // caller's to use by design.
    expect((res.body as { url: string }).url).toContain('trello-tok-1');
  });

  it('telegram: bot token in the path and resolved in the body', async () => {
    const r = template('telegram', { TELEGRAM_BOT_TOKEN: '123:tg-token' });
    await executeProxyRequest(
      {
        method: 'POST',
        url: `${base}/bot\${TELEGRAM_BOT_TOKEN}/getMe`,
        body: { echo: '${TELEGRAM_BOT_TOKEN}' },
      },
      r,
    );
    expect(received[0].url).toBe('/bot123:tg-token/getMe');
    expect(received[0].body).toBe('{"echo":"123:tg-token"}');
  });

  it('github: Authorization still injected, token refused in URL', async () => {
    const r = template('github', { GITHUB_TOKEN: 'ghp_header_only_123' });
    await executeProxyRequest({ method: 'GET', url: `${base}/user` }, r);
    expect(received[0].headers.authorization).toBe('Bearer ghp_header_only_123');
    await expect(
      executeProxyRequest({ method: 'GET', url: `${base}/repos/\${GITHUB_TOKEN}` }, r),
    ).rejects.toThrow('withholds');
  });
});
