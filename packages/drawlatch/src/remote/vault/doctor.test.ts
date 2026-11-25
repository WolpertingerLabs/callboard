/**
 * `drawlatch doctor`'s vault check. bin/drawlatch.js imports dist/, so this
 * needs `npm run build` first and is skipped without it (like
 * src/cli/doctor.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const built = fs.existsSync(path.join(repoRoot, 'dist/remote/vault/store.js'));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-vault-doctor-'));
  fs.writeFileSync(
    path.join(dir, 'remote.config.json'),
    JSON.stringify({
      host: '127.0.0.1',
      port: 1, // nothing listens here: the health check fails fast
      rateLimitPerMinute: 60,
      callers: {},
    }),
  );
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function doctor(): string {
  const run = spawnSync(process.execPath, [path.join(repoRoot, 'bin/drawlatch.js'), 'doctor'], {
    env: { ...process.env, MCP_CONFIG_DIR: dir },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return run.stdout;
}

describe.skipIf(!built)('drawlatch doctor: vault', () => {
  it('passes when no vault exists yet, and creates nothing', () => {
    expect(doctor()).toMatch(/Vault \(not created yet\)\s+PASS/);
    expect(fs.existsSync(path.join(dir, 'keys', 'vault.key'))).toBe(false);
  });

  it('flags a vault file whose key is missing, and creates no key', () => {
    fs.writeFileSync(path.join(dir, 'vault.enc.json'), '{}');
    const out = doctor();
    expect(out).toMatch(/Vault key \(keys\/vault\.key\)\s+FAIL/);
    expect(out).toContain('restore it from backup');
    expect(fs.existsSync(path.join(dir, 'keys', 'vault.key'))).toBe(false);
  });

  it('flags a group-readable key', () => {
    fs.mkdirSync(path.join(dir, 'keys'));
    fs.writeFileSync(
      path.join(dir, 'keys', 'vault.key'),
      `${Buffer.alloc(32, 7).toString('base64')}\n`,
      {
        mode: 0o644,
      },
    );
    fs.chmodSync(path.join(dir, 'keys', 'vault.key'), 0o644);
    // Local CLI output: the fix is the full path, so it works from any directory.
    expect(doctor()).toContain(`run: chmod 600 ${path.join(dir, 'keys', 'vault.key')}`);
  });
});
