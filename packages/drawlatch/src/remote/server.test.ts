/**
 * Unit tests for the remote server's exported helpers.
 *
 * checkRateLimit and cleanupSessions come from server.ts; isEndpointAllowed and
 * matchRoute from tool-dispatch.ts; resolvePlaceholders from shared/config.ts.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePlaceholders, type ResolvedRoute } from '../shared/config.js';

import {
  checkRateLimit,
  cleanupSessions,
  retryAfterSeconds,
  SESSION_TTL,
  HANDSHAKE_TTL,
} from './server.js';
import { isEndpointAllowed, matchRoute } from './tool-dispatch.js';

// ── isEndpointAllowed ──────────────────────────────────────────────────────

describe('isEndpointAllowed', () => {
  it('should allow any URL when no patterns are configured', () => {
    expect(isEndpointAllowed('https://api.example.com/anything', [])).toBe(true);
    expect(isEndpointAllowed('http://localhost:3000', [])).toBe(true);
  });

  it('should match exact URLs', () => {
    const patterns = ['https://api.example.com/v1/data'];
    expect(isEndpointAllowed('https://api.example.com/v1/data', patterns)).toBe(true);
    expect(isEndpointAllowed('https://api.example.com/v1/other', patterns)).toBe(false);
  });

  it('should match single wildcard (*) within a path segment', () => {
    const patterns = ['https://api.example.com/v1/*'];
    expect(isEndpointAllowed('https://api.example.com/v1/data', patterns)).toBe(true);
    expect(isEndpointAllowed('https://api.example.com/v1/users', patterns)).toBe(true);
    // Single * should not match across /
    expect(isEndpointAllowed('https://api.example.com/v1/users/123', patterns)).toBe(false);
  });

  it('should match double wildcard (**) across path segments', () => {
    const patterns = ['https://api.example.com/**'];
    expect(isEndpointAllowed('https://api.example.com/v1/data', patterns)).toBe(true);
    expect(isEndpointAllowed('https://api.example.com/v1/users/123', patterns)).toBe(true);
    expect(isEndpointAllowed('https://api.example.com/', patterns)).toBe(true);
  });

  it('should escape special regex characters in patterns', () => {
    const patterns = ['https://api.example.com/v1/data?key=value'];
    expect(isEndpointAllowed('https://api.example.com/v1/data?key=value', patterns)).toBe(true);
    // The ? should be escaped, not treated as regex
    expect(isEndpointAllowed('https://api.example.com/v1/datXkey=value', patterns)).toBe(false);
  });

  it('should match against multiple patterns (OR logic)', () => {
    const patterns = ['https://api.github.com/**', 'https://api.stripe.com/v1/*'];
    expect(isEndpointAllowed('https://api.github.com/repos/foo', patterns)).toBe(true);
    expect(isEndpointAllowed('https://api.stripe.com/v1/charges', patterns)).toBe(true);
    expect(isEndpointAllowed('https://api.evil.com/hack', patterns)).toBe(false);
  });

  it('should handle dots in domain names correctly', () => {
    const patterns = ['https://api.example.com/*'];
    // The dot in example.com should be escaped, not match any char
    expect(isEndpointAllowed('https://api.example.com/test', patterns)).toBe(true);
    expect(isEndpointAllowed('https://apixexamplexcom/test', patterns)).toBe(false);
  });
});

// ── resolvePlaceholders ────────────────────────────────────────────────────

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

// ── matchRoute ──────────────────────────────────────────────────────────────

describe('matchRoute', () => {
  const routes: ResolvedRoute[] = [
    {
      headers: { Authorization: 'Bearer token-a' },
      secrets: { KEY_A: 'value-a' },
      allowedEndpoints: ['https://api.a.com/**'],
      resolveSecretsInBody: false,
    },
    {
      headers: { Authorization: 'Bearer token-b' },
      secrets: { KEY_B: 'value-b' },
      allowedEndpoints: ['https://api.b.com/**'],
      resolveSecretsInBody: false,
    },
  ];

  it('should return the first matching route', () => {
    const match = matchRoute('https://api.a.com/v1/data', routes);
    expect(match).toBe(routes[0]);
  });

  it('should return the second route for matching URL', () => {
    const match = matchRoute('https://api.b.com/v2/users', routes);
    expect(match).toBe(routes[1]);
  });

  it('should return null when no route matches', () => {
    const match = matchRoute('https://api.evil.com/hack', routes);
    expect(match).toBeNull();
  });

  it('should return the first match when multiple routes could match', () => {
    const overlappingRoutes: ResolvedRoute[] = [
      {
        headers: {},
        secrets: { A: '1' },
        allowedEndpoints: ['https://api.example.com/**'],
        resolveSecretsInBody: false,
      },
      {
        headers: {},
        secrets: { B: '2' },
        allowedEndpoints: ['https://api.example.com/v1/**'],
        resolveSecretsInBody: false,
      },
    ];
    const match = matchRoute('https://api.example.com/v1/data', overlappingRoutes);
    expect(match).toBe(overlappingRoutes[0]);
  });

  it('should skip routes with empty allowedEndpoints', () => {
    const routesWithEmpty: ResolvedRoute[] = [
      { headers: {}, secrets: {}, allowedEndpoints: [], resolveSecretsInBody: false },
      {
        headers: {},
        secrets: { KEY: 'val' },
        allowedEndpoints: ['https://api.example.com/**'],
        resolveSecretsInBody: false,
      },
    ];
    const match = matchRoute('https://api.example.com/data', routesWithEmpty);
    expect(match).toBe(routesWithEmpty[1]);
  });

  it('should return null when all routes have empty allowedEndpoints', () => {
    const emptyRoutes: ResolvedRoute[] = [
      { headers: {}, secrets: {}, allowedEndpoints: [], resolveSecretsInBody: false },
      { headers: {}, secrets: {}, allowedEndpoints: [], resolveSecretsInBody: false },
    ];
    const match = matchRoute('https://anything.com', emptyRoutes);
    expect(match).toBeNull();
  });

  it('should return null for empty routes array', () => {
    const match = matchRoute('https://api.example.com/data', []);
    expect(match).toBeNull();
  });
});

// ── checkRateLimit ─────────────────────────────────────────────────────────

describe('checkRateLimit', () => {
  it('should allow requests within the rate limit', () => {
    const session = { windowRequests: 0, windowStart: Date.now() };
    const limit = 5;

    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(session, limit)).toBe(true);
    }
  });

  it('should block requests exceeding the rate limit', () => {
    const session = { windowRequests: 0, windowStart: Date.now() };
    const limit = 3;

    expect(checkRateLimit(session, limit)).toBe(true); // 1
    expect(checkRateLimit(session, limit)).toBe(true); // 2
    expect(checkRateLimit(session, limit)).toBe(true); // 3
    expect(checkRateLimit(session, limit)).toBe(false); // 4 — over limit
  });

  it('should reset the window after 60 seconds', () => {
    const now = Date.now();
    const session = {
      windowRequests: 100,
      windowStart: now - 61_000, // 61 seconds ago
    };

    // Window expired, so this should reset and allow
    expect(checkRateLimit(session, 5)).toBe(true);
    expect(session.windowRequests).toBe(1);
  });

  it('should not reset window within 60 seconds', () => {
    const now = Date.now();
    const session = {
      windowRequests: 4,
      windowStart: now - 30_000, // 30 seconds ago, within window
    };

    // Window still active, 5th request
    expect(checkRateLimit(session, 5)).toBe(true);
    // 6th request - should exceed
    expect(checkRateLimit(session, 5)).toBe(false);
  });
});

// ── retryAfterSeconds ──────────────────────────────────────────────────────

describe('retryAfterSeconds', () => {
  const start = 1_000_000;

  it('returns the whole seconds left in the window, rounded up', () => {
    expect(retryAfterSeconds({ windowStart: start }, start)).toBe(60);
    expect(retryAfterSeconds({ windowStart: start }, start + 100)).toBe(60);
    expect(retryAfterSeconds({ windowStart: start }, start + 30_000)).toBe(30);
    expect(retryAfterSeconds({ windowStart: start }, start + 58_001)).toBe(2);
  });

  it('never returns less than 1', () => {
    expect(retryAfterSeconds({ windowStart: start }, start + 59_999)).toBe(1);
    expect(retryAfterSeconds({ windowStart: start }, start + 60_000)).toBe(1);
    expect(retryAfterSeconds({ windowStart: start }, start + 600_000)).toBe(1);
  });
});

// ── cleanupSessions ────────────────────────────────────────────────────────

describe('cleanupSessions', () => {
  it('should remove sessions that exceed the SESSION_TTL', () => {
    const now = Date.now();
    const sessionsMap = new Map([
      ['active-session', { lastActivity: now - 1000 }], // 1s ago — fresh
      ['stale-session', { lastActivity: now - SESSION_TTL - 1 }], // just expired
      ['old-session', { lastActivity: now - SESSION_TTL * 2 }], // long expired
    ]);
    const pendingMap = new Map<string, { createdAt: number }>();

    const result = cleanupSessions(sessionsMap, pendingMap, now);

    expect(sessionsMap.size).toBe(1);
    expect(sessionsMap.has('active-session')).toBe(true);
    expect(sessionsMap.has('stale-session')).toBe(false);
    expect(sessionsMap.has('old-session')).toBe(false);
    expect(result.expiredSessions).toEqual(['stale-session', 'old-session']);
    expect(result.expiredHandshakes).toEqual([]);
  });

  it('should remove pending handshakes that exceed the HANDSHAKE_TTL', () => {
    const now = Date.now();
    const sessionsMap = new Map<string, { lastActivity: number }>();
    const pendingMap = new Map([
      ['fresh-hs', { createdAt: now - 1000 }], // 1s ago — fresh
      ['stale-hs', { createdAt: now - HANDSHAKE_TTL - 1 }], // just expired
    ]);

    const result = cleanupSessions(sessionsMap, pendingMap, now);

    expect(pendingMap.size).toBe(1);
    expect(pendingMap.has('fresh-hs')).toBe(true);
    expect(pendingMap.has('stale-hs')).toBe(false);
    expect(result.expiredSessions).toEqual([]);
    expect(result.expiredHandshakes).toEqual(['stale-hs']);
  });

  it('should clean up both sessions and handshakes in a single pass', () => {
    const now = Date.now();
    const sessionsMap = new Map([
      ['alive', { lastActivity: now }],
      ['dead', { lastActivity: now - SESSION_TTL - 1 }],
    ]);
    const pendingMap = new Map([
      ['alive-hs', { createdAt: now }],
      ['dead-hs', { createdAt: now - HANDSHAKE_TTL - 1 }],
    ]);

    const result = cleanupSessions(sessionsMap, pendingMap, now);

    expect(sessionsMap.size).toBe(1);
    expect(pendingMap.size).toBe(1);
    expect(result.expiredSessions).toEqual(['dead']);
    expect(result.expiredHandshakes).toEqual(['dead-hs']);
  });

  it('should handle empty maps without errors', () => {
    const sessionsMap = new Map<string, { lastActivity: number }>();
    const pendingMap = new Map<string, { createdAt: number }>();

    const result = cleanupSessions(sessionsMap, pendingMap);

    expect(result.expiredSessions).toEqual([]);
    expect(result.expiredHandshakes).toEqual([]);
  });

  it('should not remove sessions within the TTL', () => {
    const now = Date.now();
    const sessionsMap = new Map([
      ['barely-alive', { lastActivity: now - SESSION_TTL + 1000 }], // 1s before expiry
    ]);
    const pendingMap = new Map([
      ['barely-alive-hs', { createdAt: now - HANDSHAKE_TTL + 1000 }], // 1s before expiry
    ]);

    cleanupSessions(sessionsMap, pendingMap, now);

    expect(sessionsMap.size).toBe(1);
    expect(pendingMap.size).toBe(1);
  });
});

// ── module import side effects ─────────────────────────────────────────────

describe('importing server.ts', () => {
  // Hosts resolve/import this module without running the daemon; a ref'd
  // timer at module scope would keep their process alive forever.
  it('does not hold the event loop open', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'server-import-'));
    try {
      const serverUrl = new URL('./server.ts', import.meta.url).href;
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(serverUrl)});`,
        ],
        { cwd, env: { ...process.env, MCP_CONFIG_DIR: cwd }, timeout: 20_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
