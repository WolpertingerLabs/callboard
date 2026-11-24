/**
 * `drawlatch doctor` runs from bin/drawlatch.js, which imports dist/, so this
 * test needs `npm run build` first (CI builds before testing) and is skipped
 * without it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const built = fs.existsSync(path.join(repoRoot, 'dist/shared/config.js'));

describe.skipIf(!built)('drawlatch doctor', () => {
  it('fails the withheld-secrets check for an affected custom connector and exits 1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-doctor-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'remote.config.json'),
        JSON.stringify({
          host: '127.0.0.1',
          port: 1, // nothing listens here: the health check fails fast
          rateLimitPerMinute: 60,
          callers: {},
          connectors: [
            {
              alias: 'legacy',
              description: 'Use ?key=${API_KEY}',
              headers: { 'X-Api-Key': '${API_KEY}' },
              secrets: { API_KEY: '${API_KEY}' },
              allowedEndpoints: ['https://api.example.com/**'],
            },
          ],
        }),
      );
      const run = spawnSync(process.execPath, [path.join(repoRoot, 'bin/drawlatch.js'), 'doctor'], {
        env: { ...process.env, MCP_CONFIG_DIR: dir },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(run.stdout).toMatch(/Connector "legacy": withheld secrets\s+FAIL/);
      expect(run.stdout).toContain('add "API_KEY" to the connector\'s placeholderSecrets');
      expect(run.status).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Run `drawlatch doctor` against a temp config dir holding `config`. */
  function doctor(config: Record<string, unknown>, command = 'doctor') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-doctor-'));
    try {
      fs.writeFileSync(path.join(dir, 'remote.config.json'), JSON.stringify(config));
      const env: NodeJS.ProcessEnv = { ...process.env, MCP_CONFIG_DIR: dir };
      for (const k of Object.keys(env)) if (k.includes('GOOGLE_')) Reflect.deleteProperty(env, k);
      return spawnSync(process.execPath, [path.join(repoRoot, 'bin/drawlatch.js'), command], {
        env,
        encoding: 'utf8',
        timeout: 30_000,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('checks the google credentials of the mode each caller selects, and dropped connections', () => {
    const run = doctor({
      host: '127.0.0.1',
      port: 1,
      rateLimitPerMinute: 60,
      callers: {
        household: {
          connections: ['google'],
          google: { auth: 'user', services: { sheets: 'edit' } },
        },
        mail: {
          connections: ['google'],
          google: {
            auth: 'service-account',
            subject: 'alice@example.com',
            services: { gmail: 'read' },
          },
        },
        broken: {
          connections: ['google'],
          google: { auth: 'user', services: { drive: 'full' } },
        },
        stale: { connections: ['github', 'google-sheetz'] },
        migrated: { connections: ['github', 'google-docs-sa'] },
      },
    });
    expect(run.stdout).toMatch(/household\/google: GOOGLE_OAUTH_REFRESH_TOKEN\s+FAIL/);
    expect(run.stdout).not.toMatch(/household\/google: GOOGLE_SERVICE_ACCOUNT_KEY/);
    expect(run.stdout).toMatch(/mail\/google: GOOGLE_SERVICE_ACCOUNT_KEY\s+FAIL/);
    expect(run.stdout).not.toMatch(/mail\/google: GOOGLE_OAUTH/);
    expect(run.stdout).toMatch(/broken\/google: dropped\s+FAIL/);
    // The block is the problem: no secret FAILs that send the operator elsewhere.
    expect(run.stdout).not.toMatch(/broken\/google: GOOGLE_/);
    expect(run.stdout).toContain('-> google.services.drive: "full" is not offered');
    expect(run.stdout).toMatch(/Caller "stale": config\s+FAIL/);
    expect(run.stdout).toContain('-> Unknown connection "google-sheetz"');
    expect(run.stdout).toMatch(/migrated\/google-docs-sa: dropped\s+FAIL/);
    expect(run.stdout).toContain(
      '-> Connection "google-docs-sa" was removed: use "google" with callers.migrated.google.services.docs = "edit" (auth "service-account"). See CONNECTIONS.md → Google.',
    );
    expect(run.status).toBe(1);
  });

  it('config shows a dropped google, and an unknown name as unknown, not as a custom connector', () => {
    const run = doctor(
      {
        host: '127.0.0.1',
        port: 1,
        rateLimitPerMinute: 60,
        callers: {
          nogoogle: { connections: ['google', 'github'] },
          broken: {
            connections: ['google'],
            google: { auth: 'user', services: { drive: 'full' } },
          },
          ok: { connections: ['google'], google: { auth: 'user', services: { docs: 'edit' } } },
          stale: { connections: ['github', 'google-sheetz', 'google-docs'] },
        },
      },
      'config',
    );
    expect(run.stdout).toMatch(
      /nogoogle[\s\S]*google: dropped: connection "google" needs callers\.nogoogle\.google/,
    );
    expect(run.stdout).toMatch(/broken[\s\S]*google: dropped: google\.services\.drive: "full"/);
    expect(run.stdout).toContain('google: GOOGLE_OAUTH_CLIENT_ID: NOT SET');
    expect(run.stdout).toContain(
      'google-sheetz: unknown connection (neither a built-in template nor a custom connector)',
    );
    expect(run.stdout).not.toContain('google-sheetz (custom connector)');
    expect(run.stdout).toContain('google-docs: Connection "google-docs" was removed');
  });
});
