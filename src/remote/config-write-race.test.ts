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

describe('saveRemoteConfig keeps what worked before', () => {
  const tmps = (d: string) => fs.readdirSync(d).filter((f) => f.endsWith('.tmp'));

  it('writes through a symlinked config: the link stays, its target is updated', () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-config-real-'));
    try {
      const real = path.join(realDir, 'remote.config.json');
      fs.renameSync(getRemoteConfigPath(), real);
      fs.chmodSync(real, 0o640);
      fs.symlinkSync(real, getRemoteConfigPath());

      saveRemoteConfig({ ...base(), rateLimitPerMinute: 62 });

      expect(fs.lstatSync(getRemoteConfigPath()).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(getRemoteConfigPath())).toBe(real);
      expect(
        (JSON.parse(fs.readFileSync(real, 'utf8')) as RemoteServerConfig).rateLimitPerMinute,
      ).toBe(62);
      expect(fs.statSync(real).mode & 0o777).toBe(0o640);
      expect(tmps(realDir)).toEqual([]);
      expect(tmps(dir)).toEqual([]);
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'a read-only directory with a writable file still saves (in place)',
    () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      fs.chmodSync(dir, 0o500);
      try {
        saveRemoteConfig({ ...base(), rateLimitPerMinute: 63 });
        expect(loadRemoteConfig().rateLimitPerMinute).toBe(63);
        expect(tmps(dir)).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not atomic/));
      } finally {
        fs.chmodSync(dir, 0o700);
        warn.mockRestore();
      }
    },
  );

  it.each(['writeSync', 'fsyncSync', 'fchmodSync', 'renameSync'] as const)(
    'a failing %s leaves no temp file and the old config intact',
    (fn) => {
      const before = fs.readFileSync(getRemoteConfigPath(), 'utf8');
      const spy = vi.spyOn(fs, fn).mockImplementation(() => {
        throw Object.assign(new Error(`simulated ${fn} failure`), { code: 'EIO' });
      });
      try {
        expect(() => saveRemoteConfig({ ...base(), rateLimitPerMinute: 64 })).toThrow(
          `simulated ${fn} failure`,
        );
      } finally {
        spy.mockRestore();
      }
      expect(tmps(dir)).toEqual([]);
      expect(fs.readFileSync(getRemoteConfigPath(), 'utf8')).toBe(before);
    },
  );
});

describe('delete_listener_instance vs a concurrent config write', () => {
  function withInstance(): void {
    const cfg = base();
    cfg.callers.alice.listenerInstances = { github: { one: {}, two: {} } };
    saveRemoteConfig(cfg);
  }

  function mgr(stop: () => Promise<unknown>): IngestorManager {
    return { has: () => true, stopOne: stop } as unknown as IngestorManager;
  }

  it('a google selection saved while the listener stops is kept', async () => {
    withInstance();
    const result = await dispatchTool(
      'delete_listener_instance',
      { connection: 'github', instance_id: 'one' },
      [],
      {
        ...ctx(() => Promise.resolve({ success: true })),
        ingestorManager: mgr(() => {
          concurrentGoogleSave();
          return Promise.resolve({ success: true });
        }),
      },
    );
    expect(result).toMatchObject({ success: true, instance_id: 'one' });
    const after = loadRemoteConfig().callers.alice;
    expect(after.google).toEqual(GOOGLE);
    expect(after.listenerInstances).toEqual({ github: { two: {} } });
  });

  it('a caller deleted during the await is not recreated', async () => {
    withInstance();
    const result = await dispatchTool(
      'delete_listener_instance',
      { connection: 'github', instance_id: 'one' },
      [],
      {
        ...ctx(() => Promise.resolve({ success: true })),
        ingestorManager: mgr(() => {
          const raw = JSON.parse(fs.readFileSync(getRemoteConfigPath(), 'utf8')) as {
            callers: Record<string, unknown>;
          };
          delete raw.callers.alice;
          fs.writeFileSync(getRemoteConfigPath(), JSON.stringify(raw, null, 2));
          return Promise.resolve({ success: true });
        }),
      },
    );
    expect(result).toMatchObject({ success: false });
    expect(Object.hasOwn(loadRemoteConfig().callers, 'alice')).toBe(false);
  });
});
