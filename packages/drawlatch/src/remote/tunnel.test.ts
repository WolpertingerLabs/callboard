/**
 * Unit tests for the Cloudflare tunnel module.
 *
 * These tests mock `child_process.spawn` to avoid requiring `cloudflared` to be
 * installed in CI.  They exercise URL parsing, timeout handling, error paths,
 * and the stop() lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// ── Mock setup ─────────────────────────────────────────────────────────────

// We mock child_process.spawn so we can control the fake cloudflared process.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { startTunnel, isCloudflaredAvailable } from './tunnel.js';

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

/** Create a fake child process whose stderr/stdout we can push data into. */
function createFakeChild(): ChildProcess & {
  _stderr: EventEmitter;
  _stdout: EventEmitter;
  _simulateExit: (code: number) => void;
} {
  const child = new EventEmitter() as ChildProcess & {
    _stderr: EventEmitter;
    _stdout: EventEmitter;
    _simulateExit: (code: number) => void;
    exitCode: number | null;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };

  child._stderr = new EventEmitter();
  child._stdout = new EventEmitter();
  child.stderr = child._stderr as ChildProcess['stderr'];
  child.stdout = child._stdout as ChildProcess['stdout'];
  child.exitCode = null;
  child.pid = 12345;
  child.kill = vi.fn((signal?: string) => {
    // Simulate process exiting after SIGTERM/SIGKILL
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      child.exitCode = 0;
      setTimeout(() => child.emit('close', 0), 10);
    }
    return true;
  });

  child._simulateExit = (code: number) => {
    child.exitCode = code;
    child.emit('close', code);
  };

  return child as ChildProcess & {
    _stderr: EventEmitter;
    _stdout: EventEmitter;
    _simulateExit: (code: number) => void;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('isCloudflaredAvailable', () => {
  it('returns true when cloudflared --version exits with code 0', async () => {
    const child = new EventEmitter() as ChildProcess;
    mockSpawn.mockReturnValueOnce(child);

    const promise = isCloudflaredAvailable();
    child.emit('close', 0);

    expect(await promise).toBe(true);
  });

  it('returns false when cloudflared is not found (spawn error)', async () => {
    const child = new EventEmitter() as ChildProcess;
    mockSpawn.mockReturnValueOnce(child);

    const promise = isCloudflaredAvailable();
    child.emit('error', new Error('ENOENT'));

    expect(await promise).toBe(false);
  });

  it('returns false when cloudflared exits with non-zero code', async () => {
    const child = new EventEmitter() as ChildProcess;
    mockSpawn.mockReturnValueOnce(child);

    const promise = isCloudflaredAvailable();
    child.emit('close', 1);

    expect(await promise).toBe(false);
  });
});

describe('startTunnel', () => {
  it('resolves with the tunnel URL when cloudflared emits it on stderr', async () => {
    // First call: isCloudflaredAvailable (--version)
    const versionChild = new EventEmitter() as ChildProcess;
    // Second call: actual tunnel spawn
    const tunnelChild = createFakeChild();

    mockSpawn.mockReturnValueOnce(versionChild).mockReturnValueOnce(tunnelChild);

    const promise = startTunnel({ port: 9999, host: '127.0.0.1', timeout: 5000 });

    // Simulate cloudflared --version succeeding
    versionChild.emit('close', 0);

    // Wait a tick for the tunnel spawn to happen
    await new Promise((r) => setTimeout(r, 0));

    // Simulate cloudflared emitting the tunnel URL on stderr
    tunnelChild._stderr.emit(
      'data',
      Buffer.from('INF |  https://busy-fish-example.trycloudflare.com  |\n'),
    );

    const result = await promise;

    expect(result.url).toBe('https://busy-fish-example.trycloudflare.com');
    expect(typeof result.stop).toBe('function');
  });

  it('resolves with the tunnel URL when cloudflared emits it on stdout', async () => {
    const versionChild = new EventEmitter() as ChildProcess;
    const tunnelChild = createFakeChild();

    mockSpawn.mockReturnValueOnce(versionChild).mockReturnValueOnce(tunnelChild);

    const promise = startTunnel({ port: 9999, host: '127.0.0.1', timeout: 5000 });
    versionChild.emit('close', 0);
    await new Promise((r) => setTimeout(r, 0));

    tunnelChild._stdout.emit('data', Buffer.from('https://bright-moon-test.trycloudflare.com\n'));

    const result = await promise;
    expect(result.url).toBe('https://bright-moon-test.trycloudflare.com');
  });

  it('rejects when cloudflared is not available', async () => {
    const versionChild = new EventEmitter() as ChildProcess;
    mockSpawn.mockReturnValueOnce(versionChild);

    const promise = startTunnel({ port: 9999, host: '127.0.0.1' });
    versionChild.emit('error', new Error('ENOENT'));

    await expect(promise).rejects.toThrow('cloudflared binary not found');
  });

  it('rejects when the tunnel URL is not emitted within the timeout', async () => {
    const versionChild = new EventEmitter() as ChildProcess;
    const tunnelChild = createFakeChild();

    mockSpawn.mockReturnValueOnce(versionChild).mockReturnValueOnce(tunnelChild);

    const promise = startTunnel({ port: 9999, host: '127.0.0.1', timeout: 50 });
    versionChild.emit('close', 0);

    await expect(promise).rejects.toThrow('Timed out');
  });

  it('rejects when cloudflared exits before emitting a URL', async () => {
    const versionChild = new EventEmitter() as ChildProcess;
    const tunnelChild = createFakeChild();

    mockSpawn.mockReturnValueOnce(versionChild).mockReturnValueOnce(tunnelChild);

    const promise = startTunnel({ port: 9999, host: '127.0.0.1', timeout: 5000 });
    versionChild.emit('close', 0);
    await new Promise((r) => setTimeout(r, 0));

    tunnelChild._simulateExit(1);

    await expect(promise).rejects.toThrow('exited with code 1');
  });

  it('rejects when cloudflared spawn emits an error', async () => {
    const versionChild = new EventEmitter() as ChildProcess;
    const tunnelChild = createFakeChild();

    mockSpawn.mockReturnValueOnce(versionChild).mockReturnValueOnce(tunnelChild);

    const promise = startTunnel({ port: 9999, host: '127.0.0.1', timeout: 5000 });
    versionChild.emit('close', 0);
    await new Promise((r) => setTimeout(r, 0));

    tunnelChild.emit('error', new Error('spawn error'));

    await expect(promise).rejects.toThrow('cloudflared failed to start');
  });

  it('stop() sends SIGTERM and resolves when the process exits', async () => {
    const versionChild = new EventEmitter() as ChildProcess;
    const tunnelChild = createFakeChild();

    mockSpawn.mockReturnValueOnce(versionChild).mockReturnValueOnce(tunnelChild);

    const promise = startTunnel({ port: 9999, host: '127.0.0.1', timeout: 5000 });
    versionChild.emit('close', 0);
    await new Promise((r) => setTimeout(r, 0));

    tunnelChild._stderr.emit('data', Buffer.from('https://test-stop.trycloudflare.com\n'));

    const result = await promise;
    await result.stop();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(tunnelChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stop() is a no-op if the process already exited', async () => {
    const versionChild = new EventEmitter() as ChildProcess;
    const tunnelChild = createFakeChild();

    mockSpawn.mockReturnValueOnce(versionChild).mockReturnValueOnce(tunnelChild);

    const promise = startTunnel({ port: 9999, host: '127.0.0.1', timeout: 5000 });
    versionChild.emit('close', 0);
    await new Promise((r) => setTimeout(r, 0));

    tunnelChild._stderr.emit('data', Buffer.from('https://test-noop.trycloudflare.com\n'));

    const result = await promise;

    // Simulate the process having already exited
    (tunnelChild as ChildProcess & { exitCode: number | null }).exitCode = 0;

    // stop() should resolve immediately without calling kill
    await result.stop();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(tunnelChild.kill).not.toHaveBeenCalled();
  });

  it('spawns cloudflared with the correct arguments', async () => {
    const versionChild = new EventEmitter() as ChildProcess;
    const tunnelChild = createFakeChild();

    mockSpawn.mockReturnValueOnce(versionChild).mockReturnValueOnce(tunnelChild);

    const promise = startTunnel({ port: 8080, host: '0.0.0.0', timeout: 5000 });
    versionChild.emit('close', 0);
    await new Promise((r) => setTimeout(r, 0));

    // Check the second spawn call (the tunnel spawn)
    expect(mockSpawn).toHaveBeenCalledWith(
      'cloudflared',
      ['tunnel', '--url', 'http://0.0.0.0:8080', '--no-autoupdate'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );

    // Clean up
    tunnelChild._stderr.emit('data', Buffer.from('https://test-args.trycloudflare.com\n'));
    const result = await promise;
    await result.stop();
  });
});
