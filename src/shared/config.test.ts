import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveSecrets,
  resolvePlaceholders,
  resolveRoutes,
  resolveCallerRoutes,
  loadProxyConfig,
  loadRemoteConfig,
  saveRemoteConfig,
  getConfigDir,
  getProxyConfigPath,
  getRemoteConfigPath,
  getEnvFilePath,
  resolveCallerKeyAlias,
  resolveLocalTimeout,
  resolveOutboundBudget,
  LOCAL_TIMEOUT_SLACK_MS,
  MIN_OUTBOUND_TIMEOUT_MS,
  MAX_LOCAL_TIMEOUT_MS,
  MAX_OUTBOUND_TIMEOUT_MS,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  type ProxyConfig,
} from './config.js';
import { _resetConnectionIndex } from './connections.js';

// Ensure node:fs is properly instrumentable by vitest's spy mechanism.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual.default } };
});

describe('resolvePlaceholders', () => {
  it('should replace ${VAR} with secret values', () => {
    const secrets = { API_KEY: 'sk-123', TOKEN: 'tok-456' };
    expect(resolvePlaceholders('Bearer ${TOKEN}', secrets)).toBe('Bearer tok-456');
    expect(resolvePlaceholders('${API_KEY}', secrets)).toBe('sk-123');
  });

  it('should replace multiple placeholders', () => {
    const secrets = { HOST: 'example.com', PORT: '8080' };
    expect(resolvePlaceholders('https://${HOST}:${PORT}/api', secrets)).toBe(
      'https://example.com:8080/api',
    );
  });

  it('should leave unknown placeholders unchanged and log a warning', () => {
    const secrets = { KNOWN: 'value' };
    expect(resolvePlaceholders('${UNKNOWN}', secrets)).toBe('${UNKNOWN}');
  });

  it('should return unchanged strings without placeholders', () => {
    const secrets = { KEY: 'value' };
    expect(resolvePlaceholders('no placeholders here', secrets)).toBe('no placeholders here');
  });

  it('should handle empty strings', () => {
    expect(resolvePlaceholders('', {})).toBe('');
  });

  it('should handle secrets with special characters', () => {
    const secrets = { PASS: 'p@$$w0rd!&' };
    expect(resolvePlaceholders('password=${PASS}', secrets)).toBe('password=p@$$w0rd!&');
  });
});

describe('resolveSecrets', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should pass through literal string values', () => {
    const result = resolveSecrets({
      apiKey: 'sk-1234567890',
      token: 'my-literal-token',
    });

    expect(result).toEqual({
      apiKey: 'sk-1234567890',
      token: 'my-literal-token',
    });
  });

  it('should resolve ${VAR_NAME} from prefixed environment with callerAlias', () => {
    process.env.TEST_MY_SECRET = 'resolved-value';
    process.env.TEST_ANOTHER_SECRET = 'another-value';

    const result = resolveSecrets(
      {
        secret1: '${MY_SECRET}',
        secret2: '${ANOTHER_SECRET}',
      },
      undefined,
      'test',
    );

    expect(result).toEqual({
      secret1: 'resolved-value',
      secret2: 'another-value',
    });
  });

  it('should omit secrets where env var is not found', () => {
    delete process.env.NONEXISTENT_VAR;

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* noop */
    });

    const result = resolveSecrets({
      missing: '${NONEXISTENT_VAR}',
      present: 'literal',
    });

    expect(result).toEqual({ present: 'literal' });
    expect(result).not.toHaveProperty('missing');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NONEXISTENT_VAR'));

    consoleSpy.mockRestore();
  });

  it('should handle mixed literal and env var values', () => {
    process.env.TEST_DB_PASSWORD = 'p@ssw0rd';

    const result = resolveSecrets(
      {
        host: 'localhost',
        password: '${DB_PASSWORD}',
        port: '5432',
      },
      undefined,
      'test',
    );

    expect(result).toEqual({
      host: 'localhost',
      password: 'p@ssw0rd',
      port: '5432',
    });
  });

  it('should handle empty secrets map', () => {
    const result = resolveSecrets({});
    expect(result).toEqual({});
  });

  it('should not treat partial ${} patterns as env vars', () => {
    const result = resolveSecrets({
      partialStart: '${INCOMPLETE',
      partialEnd: 'INCOMPLETE}',
      noDelim: 'JUST_A_STRING',
      withPrefix: 'prefix_${SOME_VAR}',
    });

    expect(result).toEqual({
      partialStart: '${INCOMPLETE',
      partialEnd: 'INCOMPLETE}',
      noDelim: 'JUST_A_STRING',
      withPrefix: 'prefix_${SOME_VAR}',
    });
  });

  it('should resolve env var with empty string value', () => {
    process.env.TEST_EMPTY_VAR = '';

    const result = resolveSecrets(
      {
        empty: '${EMPTY_VAR}',
      },
      undefined,
      'test',
    );

    expect(result).toEqual({ empty: '' });
  });

  it('should resolve env var with special characters', () => {
    process.env.TEST_SPECIAL_CHARS = 'p@$$w0rd!#%^&*()';

    const result = resolveSecrets(
      {
        special: '${SPECIAL_CHARS}',
      },
      undefined,
      'test',
    );

    expect(result).toEqual({ special: 'p@$$w0rd!#%^&*()' });
  });

  it('should use envOverrides before process.env', () => {
    process.env.GITHUB_TOKEN = 'from-process-env';

    const result = resolveSecrets(
      { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
      { GITHUB_TOKEN: 'from-caller-override' },
    );

    expect(result).toEqual({ GITHUB_TOKEN: 'from-caller-override' });
  });

  it('should fall back to prefixed env var when envOverrides lacks the key', () => {
    process.env.TEST_OTHER_TOKEN = 'from-prefixed-env';

    const result = resolveSecrets(
      { OTHER_TOKEN: '${OTHER_TOKEN}' },
      { GITHUB_TOKEN: 'only-this-one' },
      'test',
    );

    expect(result).toEqual({ OTHER_TOKEN: 'from-prefixed-env' });
  });

  it('should NOT fall back to bare process.env (cross-caller isolation)', () => {
    process.env.OTHER_TOKEN = 'bare-env-value';

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* noop */
    });

    const result = resolveSecrets(
      { OTHER_TOKEN: '${OTHER_TOKEN}' },
      { GITHUB_TOKEN: 'only-this-one' },
      'test',
    );

    // Should NOT resolve — bare process.env is not used
    expect(result).not.toHaveProperty('OTHER_TOKEN');
    consoleSpy.mockRestore();
  });

  it('should work with empty envOverrides and callerAlias', () => {
    process.env.TEST_MY_VAR = 'hello';

    const result = resolveSecrets({ MY_VAR: '${MY_VAR}' }, {}, 'test');

    expect(result).toEqual({ MY_VAR: 'hello' });
  });

  it('should work with undefined envOverrides and callerAlias', () => {
    process.env.TEST_MY_VAR = 'hello';

    const result = resolveSecrets({ MY_VAR: '${MY_VAR}' }, undefined, 'test');

    expect(result).toEqual({ MY_VAR: 'hello' });
  });

  it('should not resolve without callerAlias or envOverrides', () => {
    process.env.MY_VAR = 'hello';

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* noop */
    });

    const result = resolveSecrets({ MY_VAR: '${MY_VAR}' });

    // Without callerAlias, bare process.env is not checked
    expect(result).not.toHaveProperty('MY_VAR');
    consoleSpy.mockRestore();
  });
});

describe('resolveRoutes', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should resolve secrets within each route independently', () => {
    const routes = resolveRoutes([
      {
        secrets: { KEY_A: 'value-a' },
        allowedEndpoints: ['https://api.a.com/**'],
      },
      {
        secrets: { KEY_B: 'value-b' },
        allowedEndpoints: ['https://api.b.com/**'],
      },
    ]);

    expect(routes).toHaveLength(2);
    expect(routes[0].secrets).toEqual({ KEY_A: 'value-a' });
    expect(routes[1].secrets).toEqual({ KEY_B: 'value-b' });
  });

  it('should default resolveSecretsInBody to false', () => {
    const routes = resolveRoutes([
      {
        secrets: { KEY: 'value' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);

    expect(routes[0].resolveSecretsInBody).toBe(false);
  });

  it('should carry through resolveSecretsInBody when explicitly set to true', () => {
    const routes = resolveRoutes([
      {
        secrets: { KEY: 'value' },
        allowedEndpoints: ['https://api.example.com/**'],
        resolveSecretsInBody: true,
      },
    ]);

    expect(routes[0].resolveSecretsInBody).toBe(true);
  });

  it('should carry through resolveSecretsInBody when explicitly set to false', () => {
    const routes = resolveRoutes([
      {
        secrets: { KEY: 'value' },
        allowedEndpoints: ['https://api.example.com/**'],
        resolveSecretsInBody: false,
      },
    ]);

    expect(routes[0].resolveSecretsInBody).toBe(false);
  });

  it('should carry through requestTimeoutMs when set', () => {
    const routes = resolveRoutes([
      {
        secrets: { KEY: 'value' },
        allowedEndpoints: ['https://api.example.com/**'],
        requestTimeoutMs: 120_000,
      },
    ]);

    expect(routes[0].requestTimeoutMs).toBe(120_000);
  });

  it('should leave requestTimeoutMs undefined when not set', () => {
    const routes = resolveRoutes([
      {
        secrets: { KEY: 'value' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);

    expect(routes[0].requestTimeoutMs).toBeUndefined();
    expect('requestTimeoutMs' in routes[0]).toBe(false);
  });

  it('should resolve header placeholders against the route own secrets', () => {
    const routes = resolveRoutes([
      {
        headers: { Authorization: 'Bearer ${API_TOKEN}' },
        secrets: { API_TOKEN: 'my-secret-token' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);

    expect(routes[0].headers).toEqual({ Authorization: 'Bearer my-secret-token' });
  });

  it('should handle routes with no secrets', () => {
    const routes = resolveRoutes([
      {
        headers: { 'X-Custom': 'static-value' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);

    expect(routes[0].secrets).toEqual({});
    expect(routes[0].headers).toEqual({ 'X-Custom': 'static-value' });
  });

  it('should handle routes with no headers', () => {
    const routes = resolveRoutes([
      {
        secrets: { KEY: 'value' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);

    expect(routes[0].headers).toEqual({});
    expect(routes[0].secrets).toEqual({ KEY: 'value' });
  });

  it('should handle empty routes array', () => {
    const routes = resolveRoutes([]);
    expect(routes).toEqual([]);
  });

  it('should resolve env var references in secrets within routes via callerAlias', () => {
    process.env.TEST_ROUTE_SECRET = 'env-resolved-value';

    const routes = resolveRoutes(
      [
        {
          secrets: { TOKEN: '${ROUTE_SECRET}' },
          headers: { Authorization: 'Bearer ${TOKEN}' },
          allowedEndpoints: ['https://api.example.com/**'],
        },
      ],
      undefined,
      'test',
    );

    expect(routes[0].secrets).toEqual({ TOKEN: 'env-resolved-value' });
    expect(routes[0].headers).toEqual({ Authorization: 'Bearer env-resolved-value' });
  });

  it('should apply envOverrides during route resolution', () => {
    process.env.GITHUB_TOKEN = 'default-token';

    const routes = resolveRoutes(
      [
        {
          secrets: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
          headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
          allowedEndpoints: ['https://api.github.com/**'],
        },
      ],
      { GITHUB_TOKEN: 'caller-specific-token' },
    );

    expect(routes[0].secrets).toEqual({ GITHUB_TOKEN: 'caller-specific-token' });
    expect(routes[0].headers).toEqual({ Authorization: 'Bearer caller-specific-token' });
  });

  it('should apply envOverrides to multiple routes independently', () => {
    const routes = resolveRoutes(
      [
        {
          secrets: { TOKEN: '${TOKEN}' },
          headers: { Authorization: 'Bearer ${TOKEN}' },
          allowedEndpoints: ['https://api.a.com/**'],
        },
        {
          secrets: { OTHER_KEY: '${OTHER_KEY}' },
          headers: { 'X-Key': '${OTHER_KEY}' },
          allowedEndpoints: ['https://api.b.com/**'],
        },
      ],
      { TOKEN: 'overridden-token', OTHER_KEY: 'overridden-key' },
    );

    expect(routes[0].secrets).toEqual({ TOKEN: 'overridden-token' });
    expect(routes[0].headers).toEqual({ Authorization: 'Bearer overridden-token' });
    expect(routes[1].secrets).toEqual({ OTHER_KEY: 'overridden-key' });
    expect(routes[1].headers).toEqual({ 'X-Key': 'overridden-key' });
  });

  it('should not leak secrets across routes when resolving headers', () => {
    const routes = resolveRoutes([
      {
        headers: { Authorization: 'Bearer ${TOKEN_A}' },
        secrets: { TOKEN_A: 'secret-a' },
        allowedEndpoints: ['https://api.a.com/**'],
      },
      {
        headers: { Authorization: 'Bearer ${TOKEN_A}' },
        secrets: { TOKEN_B: 'secret-b' },
        allowedEndpoints: ['https://api.b.com/**'],
      },
    ]);

    // Route A should resolve TOKEN_A
    expect(routes[0].headers).toEqual({ Authorization: 'Bearer secret-a' });
    // Route B should NOT resolve TOKEN_A (it only has TOKEN_B)
    expect(routes[1].headers).toEqual({ Authorization: 'Bearer ${TOKEN_A}' });
  });

  // ── New field carry-through tests ──────────────────────────────────────

  it('should carry through alias when present', () => {
    const routes = resolveRoutes([
      {
        alias: 'github',
        secrets: { TOKEN: 'tok' },
        allowedEndpoints: ['https://api.github.com/**'],
      },
    ]);
    expect(routes[0].alias).toBe('github');
  });

  it('should not set alias when not present', () => {
    const routes = resolveRoutes([
      {
        secrets: { TOKEN: 'tok' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);
    expect(routes[0].alias).toBeUndefined();
  });

  it('should carry through testConnection when present', () => {
    const testConnection = {
      url: 'https://api.github.com/user',
      description: 'Test GitHub credentials',
    };
    const routes = resolveRoutes([
      {
        secrets: { TOKEN: 'tok' },
        allowedEndpoints: ['https://api.github.com/**'],
        testConnection,
      },
    ]);
    expect(routes[0].testConnection).toEqual(testConnection);
  });

  it('should not set testConnection when not present', () => {
    const routes = resolveRoutes([
      {
        secrets: { TOKEN: 'tok' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);
    expect(routes[0].testConnection).toBeUndefined();
  });

  it('should carry through testIngestor when present', () => {
    const testIngestor = {
      description: 'Test webhook config',
      strategy: 'webhook_verify' as const,
      requireSecrets: ['WEBHOOK_SECRET'],
    };
    const routes = resolveRoutes([
      {
        secrets: { TOKEN: 'tok' },
        allowedEndpoints: ['https://api.example.com/**'],
        testIngestor,
      },
    ]);
    expect(routes[0].testIngestor).toEqual(testIngestor);
  });

  it('should carry through testIngestor when explicitly null', () => {
    const routes = resolveRoutes([
      {
        secrets: { TOKEN: 'tok' },
        allowedEndpoints: ['https://api.example.com/**'],
        testIngestor: null,
      },
    ]);
    expect(routes[0].testIngestor).toBeNull();
  });

  it('should not set testIngestor when not present', () => {
    const routes = resolveRoutes([
      {
        secrets: { TOKEN: 'tok' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);
    expect(routes[0].testIngestor).toBeUndefined();
  });

  it('should carry through listenerConfig when present', () => {
    const listenerConfig = {
      name: 'Discord Gateway Listener',
      description: 'Listens to Discord events',
      fields: [
        {
          key: 'guildIds',
          label: 'Guild IDs',
          type: 'text[]' as const,
          default: [],
        },
      ],
    };
    const routes = resolveRoutes([
      {
        secrets: { TOKEN: 'tok' },
        allowedEndpoints: ['https://discord.com/api/**'],
        listenerConfig,
      },
    ]);
    expect(routes[0].listenerConfig).toEqual(listenerConfig);
  });

  it('should not set listenerConfig when not present', () => {
    const routes = resolveRoutes([
      {
        secrets: { TOKEN: 'tok' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);
    expect(routes[0].listenerConfig).toBeUndefined();
  });

  it('should carry through ingestorConfig (from ingestor) when present', () => {
    const ingestor = {
      type: 'webhook' as const,
      webhook: {
        path: 'github',
        signatureHeader: 'X-Hub-Signature-256',
        signatureSecret: 'GITHUB_WEBHOOK_SECRET',
      },
    };
    const routes = resolveRoutes([
      {
        secrets: { TOKEN: 'tok' },
        allowedEndpoints: ['https://api.github.com/**'],
        ingestor,
      },
    ]);
    expect(routes[0].ingestorConfig).toEqual(ingestor);
  });

  it('should not set ingestorConfig when not present', () => {
    const routes = resolveRoutes([
      {
        secrets: { TOKEN: 'tok' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);
    expect(routes[0].ingestorConfig).toBeUndefined();
  });

  it('should carry through all new fields together', () => {
    const testConnection = { url: 'https://api.github.com/user', description: 'Test' };
    const testIngestor = {
      description: 'Verify webhook',
      strategy: 'webhook_verify' as const,
      requireSecrets: ['SECRET'],
    };
    const listenerConfig = {
      name: 'Listener',
      fields: [{ key: 'eventFilter', label: 'Events', type: 'multiselect' as const }],
    };
    const ingestor = { type: 'webhook' as const, webhook: { path: 'github' } };

    const routes = resolveRoutes([
      {
        alias: 'github',
        name: 'GitHub API',
        description: 'GitHub',
        docsUrl: 'https://docs.github.com',
        openApiUrl: 'https://raw.github.com/openapi.json',
        secrets: { TOKEN: 'tok' },
        allowedEndpoints: ['https://api.github.com/**'],
        testConnection,
        testIngestor,
        listenerConfig,
        ingestor,
      },
    ]);

    const resolved = routes[0];
    expect(resolved.alias).toBe('github');
    expect(resolved.name).toBe('GitHub API');
    expect(resolved.description).toBe('GitHub');
    expect(resolved.docsUrl).toBe('https://docs.github.com');
    expect(resolved.openApiUrl).toBe('https://raw.github.com/openapi.json');
    expect(resolved.testConnection).toEqual(testConnection);
    expect(resolved.testIngestor).toEqual(testIngestor);
    expect(resolved.listenerConfig).toEqual(listenerConfig);
    expect(resolved.ingestorConfig).toEqual(ingestor);
  });
});

describe('config exports', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should export expected path getter functions', () => {
    process.env = { ...originalEnv };
    delete process.env.MCP_CONFIG_DIR;
    expect(getConfigDir()).toBe(path.join(os.homedir(), '.drawlatch'));
  });

  it('should export split config path getter functions', () => {
    expect(getProxyConfigPath()).toContain('proxy.config.json');
    expect(getRemoteConfigPath()).toContain('remote.config.json');
  });
});

describe('getEnvFilePath', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return .env path under default config dir', () => {
    process.env = { ...originalEnv };
    delete process.env.MCP_CONFIG_DIR;

    expect(getEnvFilePath()).toBe(path.join(os.homedir(), '.drawlatch', '.env'));
  });

  it('should respect MCP_CONFIG_DIR override', () => {
    process.env = { ...originalEnv, MCP_CONFIG_DIR: '/custom/config' };

    expect(getEnvFilePath()).toBe(path.join('/custom/config', '.env'));
  });
});

describe('loadProxyConfig', () => {
  it('should return defaults when no config files exist', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadProxyConfig();

    expect(config.remoteUrl).toBe('http://localhost:9999');
    expect(config.connectTimeout).toBe(10_000);
    expect(config.requestTimeout).toBe(185_000);

    existsSpy.mockRestore();
  });

  it('should read from proxy.config.json when it exists', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return String(p) === getProxyConfigPath();
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        remoteUrl: 'https://custom-proxy.example.com:8443',
        connectTimeout: 5000,
      }),
    );

    const config = loadProxyConfig();

    expect(config.remoteUrl).toBe('https://custom-proxy.example.com:8443');
    expect(config.connectTimeout).toBe(5000);
    // Default values still present
    expect(config.requestTimeout).toBe(185_000);

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });
});

describe('resolveCallerKeyAlias', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MCP_KEY_ALIAS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should resolve MCP_KEY_ALIAS env var', () => {
    process.env.MCP_KEY_ALIAS = 'alice';
    expect(resolveCallerKeyAlias()).toBe('alice');
  });

  it('should default to "default" when nothing is set', () => {
    expect(resolveCallerKeyAlias()).toBe('default');
  });

  it('should trim whitespace from MCP_KEY_ALIAS', () => {
    process.env.MCP_KEY_ALIAS = '  alice  ';
    expect(resolveCallerKeyAlias()).toBe('alice');
  });

  it('should ignore empty or whitespace-only MCP_KEY_ALIAS', () => {
    process.env.MCP_KEY_ALIAS = '   ';
    expect(resolveCallerKeyAlias()).toBe('default');
  });
});

describe('loadRemoteConfig', () => {
  it('should return defaults when no config files exist', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadRemoteConfig();

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(9999);
    expect(config.callers).toEqual({});
    expect(config.rateLimitPerMinute).toBe(240);

    existsSpy.mockRestore();
  });

  it('should read from remote.config.json when it exists', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return String(p) === getRemoteConfigPath();
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        host: '0.0.0.0',
        port: 8080,
        connectors: [
          {
            alias: 'my-api',
            secrets: { KEY: 'value' },
            allowedEndpoints: ['https://api.example.com/**'],
          },
        ],
        callers: {
          laptop: {
            connections: ['my-api'],
          },
        },
      }),
    );

    const config = loadRemoteConfig();

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.connectors).toHaveLength(1);
    expect(config.callers.laptop.connections).toEqual(['my-api']);
    // Default values still present
    expect(config.rateLimitPerMinute).toBe(240);

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });
});

describe('resolveCallerRoutes', () => {
  it('should resolve custom connector by alias', () => {
    const config = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        { alias: 'my-api', name: 'My API', allowedEndpoints: ['https://api.example.com/**'] },
      ],
      callers: {
        laptop: { connections: ['my-api'] },
      },
      rateLimitPerMinute: 60,
    };

    const routes = resolveCallerRoutes(config, 'laptop');

    expect(routes).toHaveLength(1);
    expect(routes[0].name).toBe('My API');
    expect(routes[0].allowedEndpoints).toEqual(['https://api.example.com/**']);
  });

  it('should resolve built-in template by name', () => {
    _resetConnectionIndex();
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      return s.includes('connections') || s.endsWith('test-conn.json');
    });
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((_dir: any, opts?: any) => {
      if (opts?.withFileTypes) {
        return [{ name: 'test-category', isFile: () => false, isDirectory: () => true }] as any;
      }
      return ['test-conn.json'] as any;
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (String(p).endsWith('test-conn.json')) {
        return JSON.stringify({
          name: 'Test Connection',
          allowedEndpoints: ['https://api.test.com/**'],
        });
      }
      throw new Error(`Unexpected read: ${String(p)}`);
    });

    const config = {
      host: '127.0.0.1',
      port: 9999,

      callers: {
        laptop: { connections: ['test-conn'] },
      },
      rateLimitPerMinute: 60,
    };

    const routes = resolveCallerRoutes(config, 'laptop');

    expect(routes).toHaveLength(1);
    expect(routes[0].name).toBe('Test Connection');

    existsSpy.mockRestore();
    readdirSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('should return empty array for unknown caller', () => {
    const config = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [{ alias: 'my-api', allowedEndpoints: ['https://api.example.com/**'] }],
      callers: {
        laptop: { connections: ['my-api'] },
      },
      rateLimitPerMinute: 60,
    };

    const routes = resolveCallerRoutes(config, 'unknown-caller');
    expect(routes).toEqual([]);
  });

  it('should handle mix of custom connectors and built-in templates', () => {
    _resetConnectionIndex();
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      return s.includes('connections') || s.endsWith('test-conn.json');
    });
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((_dir: any, opts?: any) => {
      if (opts?.withFileTypes) {
        return [{ name: 'test-category', isFile: () => false, isDirectory: () => true }] as any;
      }
      return ['test-conn.json'] as any;
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (String(p).endsWith('test-conn.json')) {
        return JSON.stringify({
          name: 'Built-in Template',
          allowedEndpoints: ['https://api.builtin.com/**'],
        });
      }
      throw new Error(`Unexpected read: ${String(p)}`);
    });

    const config = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        {
          alias: 'custom-api',
          name: 'Custom API',
          allowedEndpoints: ['https://api.custom.com/**'],
        },
      ],
      callers: {
        laptop: { connections: ['custom-api', 'test-conn'] },
      },
      rateLimitPerMinute: 60,
    };

    const routes = resolveCallerRoutes(config, 'laptop');

    expect(routes).toHaveLength(2);
    expect(routes[0].name).toBe('Custom API');
    expect(routes[1].name).toBe('Built-in Template');

    existsSpy.mockRestore();
    readdirSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('should give custom connectors precedence over built-in templates with same name', () => {
    const config = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        {
          alias: 'github',
          name: 'Custom GitHub Override',
          allowedEndpoints: ['https://custom-github.example.com/**'],
        },
      ],
      callers: {
        laptop: { connections: ['github'] },
      },
      rateLimitPerMinute: 60,
    };

    const routes = resolveCallerRoutes(config, 'laptop');

    expect(routes).toHaveLength(1);
    expect(routes[0].name).toBe('Custom GitHub Override');
    expect(routes[0].allowedEndpoints).toEqual(['https://custom-github.example.com/**']);
  });

  it('should inject alias into routes from built-in templates', () => {
    _resetConnectionIndex();
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      return s.includes('connections') || s.endsWith('test-conn.json');
    });
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((_dir: any, opts?: any) => {
      if (opts?.withFileTypes) {
        return [{ name: 'test-category', isFile: () => false, isDirectory: () => true }] as any;
      }
      return ['test-conn.json'] as any;
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (String(p).endsWith('test-conn.json')) {
        return JSON.stringify({
          name: 'Test Connection',
          allowedEndpoints: ['https://api.test.com/**'],
          // Note: no alias property in the template
        });
      }
      throw new Error(`Unexpected read: ${String(p)}`);
    });

    const config = {
      host: '127.0.0.1',
      port: 9999,

      callers: {
        laptop: { connections: ['test-conn'] },
      },
      rateLimitPerMinute: 60,
    };

    const routes = resolveCallerRoutes(config, 'laptop');

    expect(routes).toHaveLength(1);
    // The alias should be injected from the connection name
    expect(routes[0].alias).toBe('test-conn');

    existsSpy.mockRestore();
    readdirSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('should preserve existing alias when it matches connection name', () => {
    const config = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        {
          alias: 'custom-api',
          name: 'Custom API',
          allowedEndpoints: ['https://api.custom.com/**'],
        },
      ],
      callers: {
        laptop: { connections: ['custom-api'] },
      },
      rateLimitPerMinute: 60,
    };

    const routes = resolveCallerRoutes(config, 'laptop');

    expect(routes).toHaveLength(1);
    expect(routes[0].alias).toBe('custom-api');
  });

  it('should carry testConnection through resolveCallerRoutes', () => {
    const testConnection = { url: 'https://api.example.com/me', description: 'Check creds' };
    const config = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        {
          alias: 'my-api',
          allowedEndpoints: ['https://api.example.com/**'],
          testConnection,
        },
      ],
      callers: {
        laptop: { connections: ['my-api'] },
      },
      rateLimitPerMinute: 60,
    };

    const routes = resolveCallerRoutes(config, 'laptop');
    expect(routes[0].testConnection).toEqual(testConnection);
  });

  it('should carry testIngestor and listenerConfig through resolveCallerRoutes', () => {
    const testIngestor = { description: 'Verify webhook', strategy: 'webhook_verify' as const };
    const listenerConfig = {
      name: 'Listener',
      fields: [{ key: 'eventFilter', label: 'Events', type: 'multiselect' as const }],
    };
    const config = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        {
          alias: 'my-api',
          allowedEndpoints: ['https://api.example.com/**'],
          ingestor: { type: 'webhook' as const, webhook: { path: 'myapi' } },
          testIngestor,
          listenerConfig,
        },
      ],
      callers: {
        laptop: { connections: ['my-api'] },
      },
      rateLimitPerMinute: 60,
    };

    const routes = resolveCallerRoutes(config, 'laptop');
    expect(routes[0].testIngestor).toEqual(testIngestor);
    expect(routes[0].listenerConfig).toEqual(listenerConfig);
    expect(routes[0].ingestor).toBeDefined();
  });

  it('should handle config with no connectors array', () => {
    _resetConnectionIndex();
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      return s.includes('connections') || s.endsWith('test-conn.json');
    });
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((_dir: any, opts?: any) => {
      if (opts?.withFileTypes) {
        return [{ name: 'test-category', isFile: () => false, isDirectory: () => true }] as any;
      }
      return ['test-conn.json'] as any;
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (String(p).endsWith('test-conn.json')) {
        return JSON.stringify({
          name: 'Test Connection',
          allowedEndpoints: ['https://api.test.com/**'],
        });
      }
      throw new Error(`Unexpected read: ${String(p)}`);
    });

    const config = {
      host: '127.0.0.1',
      port: 9999,

      callers: {
        laptop: { connections: ['test-conn'] },
      },
      rateLimitPerMinute: 60,
    };

    const routes = resolveCallerRoutes(config, 'laptop');
    expect(routes).toHaveLength(1);

    existsSpy.mockRestore();
    readdirSpy.mockRestore();
    readSpy.mockRestore();
  });
});

describe('saveRemoteConfig', () => {
  it('creates the config directory and writes the remote config file atomically', () => {
    const prev = process.env.MCP_CONFIG_DIR;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-save-remote-'));
    process.env.MCP_CONFIG_DIR = path.join(root, 'nested');
    const rename = vi.spyOn(fs, 'renameSync');
    try {
      saveRemoteConfig({
        host: '127.0.0.1',
        port: 9999,
        callers: {
          laptop: { connections: ['github'] },
        },
        rateLimitPerMinute: 60,
      });

      expect(fs.statSync(getConfigDir()).mode & 0o777).toBe(0o700);
      // Temp file in the same directory, renamed over the target.
      expect(rename).toHaveBeenCalledTimes(1);
      expect(rename.mock.calls[0][1]).toBe(getRemoteConfigPath());
      expect(fs.statSync(getRemoteConfigPath()).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(getConfigDir())).toEqual(['remote.config.json']);

      // Valid JSON with a flat structure (no .remote wrapper)
      const parsed = JSON.parse(fs.readFileSync(getRemoteConfigPath(), 'utf-8'));
      expect(parsed.host).toBe('127.0.0.1');
      expect(parsed.port).toBe(9999);
      expect(parsed.callers.laptop.connections).toEqual(['github']);
      expect(parsed.remote).toBeUndefined(); // Should be flat, not nested
    } finally {
      rename.mockRestore();
      if (prev === undefined) delete process.env.MCP_CONFIG_DIR;
      else process.env.MCP_CONFIG_DIR = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Nested request deadlines ───────────────────────────────────────────────

describe('timeout constants', () => {
  it('should order the chain innermost-first out of the box', () => {
    // remote → upstream default < local → remote default < MCP client cap.
    const shippedLocal = 185_000;
    expect(DEFAULT_OUTBOUND_TIMEOUT_MS).toBeLessThan(shippedLocal);
    expect(DEFAULT_OUTBOUND_TIMEOUT_MS + LOCAL_TIMEOUT_SLACK_MS).toBeLessThan(60_000);
  });

  it("should keep the outbound max below undici's 300s headers timeout", () => {
    // An AbortSignal races undici's internal timeout rather than replacing it,
    // so anything at or above 300s is unreachable and surfaces as an opaque
    // UND_ERR_HEADERS_TIMEOUT instead of a drawlatch error.
    expect(MAX_OUTBOUND_TIMEOUT_MS).toBeLessThan(300_000);
  });

  it("should keep the local max well inside Node's 32-bit timer range", () => {
    expect(MAX_LOCAL_TIMEOUT_MS).toBeLessThan(2_147_483_647);
  });
});

describe('resolveLocalTimeout', () => {
  const config: ProxyConfig = {
    remoteUrl: 'http://localhost:9999',
    connectTimeout: 10_000,
    requestTimeout: 185_000,
  };

  it('should fall back to requestTimeout when no timeoutMs is given', () => {
    expect(resolveLocalTimeout({}, config)).toBe(185_000);
  });

  it('should leave the built-in default requestTimeout unclamped', () => {
    // `drawlatch init` scaffolds proxy.config.json from these defaults, so a
    // default above MAX_LOCAL_TIMEOUT_MS would be silently cut down.
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const defaults = loadProxyConfig();
    existsSpy.mockRestore();

    expect(defaults.requestTimeout).toBeLessThanOrEqual(MAX_LOCAL_TIMEOUT_MS);
    expect(resolveLocalTimeout({}, defaults)).toBe(defaults.requestTimeout);
  });

  it('should derive from timeoutMs plus slack when one is given', () => {
    expect(resolveLocalTimeout({ timeoutMs: 120_000 }, config)).toBe(
      120_000 + LOCAL_TIMEOUT_SLACK_MS,
    );
  });

  it.each([0, -1, NaN, Infinity, '30000', null])(
    'should ignore a malformed timeoutMs of %p',
    (bad) => {
      expect(resolveLocalTimeout({ timeoutMs: bad }, config)).toBe(185_000);
    },
  );

  // Unclamped, a delay above 2147483647 makes Node emit TimeoutOverflowWarning
  // and collapse the timer to 1ms: the local POST aborts in ~2ms while the
  // remote's fetch runs on and bills. Triggered by asking for a *longer*
  // timeout, which is the opposite of what the caller wanted.
  describe('32-bit timer overflow', () => {
    it.each([2_147_483_647, 4_294_962_296, Number.MAX_SAFE_INTEGER])(
      'should clamp a timeoutMs of %p rather than overflow the timer',
      (huge) => {
        const resolved = resolveLocalTimeout({ timeoutMs: huge }, config);
        expect(resolved).toBe(MAX_LOCAL_TIMEOUT_MS);
        expect(resolved).toBeLessThan(2_147_483_647);
      },
    );

    it('should clamp an absurd configured requestTimeout too', () => {
      expect(resolveLocalTimeout({}, { ...config, requestTimeout: 9_999_999_999 })).toBe(
        MAX_LOCAL_TIMEOUT_MS,
      );
    });

    it('should arm a usable AbortSignal at the clamped value', () => {
      const resolved = resolveLocalTimeout({ timeoutMs: Number.MAX_SAFE_INTEGER }, config);
      // Unclamped this throws RangeError [ERR_OUT_OF_RANGE].
      expect(() => AbortSignal.timeout(resolved)).not.toThrow();
    });

    it.each([0, -1, NaN, Infinity])(
      'should clamp up, not down, for a requestTimeout of %p',
      (bad) => {
        expect(resolveLocalTimeout({}, { ...config, requestTimeout: bad })).toBe(
          MAX_LOCAL_TIMEOUT_MS,
        );
      },
    );
  });
});

describe('resolveOutboundBudget', () => {
  // Derived from the deadline actually armed, not from config.requestTimeout —
  // otherwise a caller who explicitly asked for 120s (and whose socket will
  // wait 125s) would still be handed a 25s budget.
  it('should subtract slack exactly once from the armed deadline', () => {
    expect(resolveOutboundBudget(125_000)).toBe(120_000);
  });

  it('should track a caller-raised timeoutMs rather than the flat requestTimeout', () => {
    const config: ProxyConfig = {
      remoteUrl: 'http://localhost:9999',
      connectTimeout: 10_000,
      requestTimeout: 30_000,
    };
    const armed = resolveLocalTimeout({ timeoutMs: 120_000 }, config);
    expect(resolveOutboundBudget(armed)).toBe(120_000);
  });

  it('should floor a pathologically small deadline instead of going negative', () => {
    expect(resolveOutboundBudget(LOCAL_TIMEOUT_SLACK_MS)).toBe(MIN_OUTBOUND_TIMEOUT_MS);
    expect(resolveOutboundBudget(LOCAL_TIMEOUT_SLACK_MS + 1)).toBe(MIN_OUTBOUND_TIMEOUT_MS);
  });

  it('should never return a budget longer than the deadline it derives from', () => {
    // The MIN floor must not out-rank the local deadline: a budget above the
    // local leg re-inverts the ordering this module exists to maintain, which
    // is the original orphaned-upstream-call bug at the small end.
    for (const localTimeout of [1, 100, 500, 999, 1_000, 1_001, 5_000, 6_000, 30_000, 185_000]) {
      expect(resolveOutboundBudget(localTimeout)).toBeLessThanOrEqual(localTimeout);
      expect(resolveOutboundBudget(localTimeout)).toBeGreaterThan(0);
    }
  });

  it('should give the shipped default enough room for the slowest connection', () => {
    // perplexity ships requestTimeoutMs: 180000.
    expect(resolveOutboundBudget(185_000)).toBeGreaterThanOrEqual(180_000);
  });
});
