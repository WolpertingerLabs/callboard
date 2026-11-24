/**
 * Concurrent writes to remote.config.json.
 *
 * `set_connection_enabled` awaits the listener stop between loading and
 * saving the config. A dashboard write that lands in that window (a Google
 * selection save, say) must survive: the tool re-loads and applies its change
 * to the fresh copy. And both writers replace the file atomically (temp file
 * + rename), keeping its mode, so a reader never sees a half-written file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getRemoteConfigPath,
  loadRemoteConfig,
  saveRemoteConfig,
  type RemoteServerConfig,
} from '../shared/config.js';
import { dispatchTool, type ToolContext } from './tool-dispatch.js';
import type { IngestorManager } from './ingestors/index.js';

const GOOGLE = { auth: 'user' as const, services: { sheets: 'edit' } };

let dir: string;

function base(): RemoteServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    rateLimitPerMinute: 60,
    callers: {
      alice: { connections: ['github', 'google'], selfManage: true },
    },
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-config-race-'));
  process.env.MCP_CONFIG_DIR = dir;
  saveRemoteConfig(base());
});

afterEach(() => {
  delete process.env.MCP_CONFIG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

function ctx(stopOne: () => Promise<unknown>): ToolContext {
  return {
    callerAlias: 'alice',
    origin: 'admin',
    ingestorManager: { stopOne } as unknown as IngestorManager,
    refreshRoutes: () => undefined,
  };
}

/** Another writer (the dashboard's Google route) changing the file on disk. */
function concurrentGoogleSave(): void {
  const raw = JSON.parse(fs.readFileSync(getRemoteConfigPath(), 'utf8')) as {
    callers: Record<string, Record<string, unknown>>;
  };
  raw.callers.alice.google = GOOGLE;
  fs.writeFileSync(getRemoteConfigPath(), JSON.stringify(raw, null, 2));
}

describe('set_connection_enabled vs a concurrent config write', () => {
  it('a google selection saved while the listener stops is kept', async () => {
    const result = await dispatchTool(
      'set_connection_enabled',
      { connection: 'github', enabled: false },
      [],
      ctx(() => {
        concurrentGoogleSave();
        return Promise.resolve({ success: true });
      }),
    );
    expect(result).toMatchObject({ success: true, enabled: false });
    const after = loadRemoteConfig().callers.alice;
    expect(after.connections).toEqual(['google']);
    expect(after.google).toEqual(GOOGLE);
  });

  it('a caller deleted during the await is not recreated', async () => {
    await expect(
      dispatchTool(
        'set_connection_enabled',
        { connection: 'github', enabled: false },
        [],
        ctx(() => {
          const raw = JSON.parse(fs.readFileSync(getRemoteConfigPath(), 'utf8')) as {
            callers: Record<string, unknown>;
          };
          delete raw.callers.alice;
          fs.writeFileSync(getRemoteConfigPath(), JSON.stringify(raw, null, 2));
          return Promise.resolve({ success: true });
        }),
      ),
    ).rejects.toThrow(/alice/);
    expect(Object.hasOwn(loadRemoteConfig().callers, 'alice')).toBe(false);
  });
});

describe('saveRemoteConfig is atomic', () => {
  it('writes through a temp file and rename, keeping the mode', () => {
    fs.chmodSync(getRemoteConfigPath(), 0o640);
    const rename = vi.spyOn(fs, 'renameSync');
    try {
      saveRemoteConfig({ ...base(), rateLimitPerMinute: 61 });
      expect(rename).toHaveBeenCalledTimes(1);
      const [from, to] = rename.mock.calls[0] as [string, string];
      expect(to).toBe(getRemoteConfigPath());
      expect(path.dirname(from)).toBe(path.dirname(getRemoteConfigPath()));
    } finally {
      rename.mockRestore();
    }
    expect(fs.statSync(getRemoteConfigPath()).mode & 0o777).toBe(0o640);
    expect(loadRemoteConfig().rateLimitPerMinute).toBe(61);
    // No temp file is left behind.
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('a new file is 0600', () => {
    fs.rmSync(getRemoteConfigPath());
    saveRemoteConfig(base());
    expect(fs.statSync(getRemoteConfigPath()).mode & 0o777).toBe(0o600);
  });
});
