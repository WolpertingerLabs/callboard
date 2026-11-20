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
});
