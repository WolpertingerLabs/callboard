/**
 * `drawlatch vault list` / `drawlatch vault git-credential`, run as a child
 * process of bin/drawlatch.js against a test daemon started in this process.
 *
 * bin/drawlatch.js imports dist/, so this needs `npm run build` first (CI
 * builds before testing) and is skipped without it, like doctor.test.ts.
 *
 * The daemon and the CLI use **different** config dirs. The CLI's holds only
 * what a caller has: proxy.config.json, its own keys/callers/<alias>/ and the
 * server's public keys. It has no vault file, no vault key, no .env and no
 * remote.config.json, so a passing reveal shows the CLI got the value through
 * the caller handshake and vault_get, and from nowhere else.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { createApp } from '../remote/server.js';
import { saveRemoteConfig, type RemoteServerConfig } from '../shared/config.js';
import {
  generateKeyBundle,
  extractPublicKeys,
  saveKeyBundle,
  serializeKeyBundle,
  type KeyBundle,
} from '../shared/crypto/index.js';
import { IngestorManager } from '../remote/ingestors/manager.js';
import { resetAuditLogState } from '../remote/audit-log.js';
import { createItem, grantRequest, requestAccess } from '../remote/vault/service.js';
import { readVault, resetVaultCache } from '../remote/vault/store.js';
import { PassThrough } from 'node:stream';
import { parseGitRequest, runVaultCli } from './vault.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const bin = path.join(repoRoot, 'bin/drawlatch.js');
const built = fs.existsSync(path.join(repoRoot, 'dist/cli/vault.js'));
const hasGit = spawnSync('git', ['--version']).status === 0;

const REVEAL_TOKEN = `fake-reveal-${crypto.randomUUID()}`;
const PASSWORD = `fake-password-${crypto.randomUUID()}`;
const INJECT_TOKEN = `fake-inject-${crypto.randomUUID()}`;
const BOB_INJECT_GRANTED = `fake-bob-inject-${crypto.randomUUID()}`;
const UNGRANTED = `fake-ungranted-${crypto.randomUUID()}`;
const NEWLINE_TOKEN = `fake-newline-${crypto.randomUUID()}`;
const CANARIES = [REVEAL_TOKEN, PASSWORD, INJECT_TOKEN, BOB_INJECT_GRANTED, UNGRANTED];

let server: Server;
let baseUrl: string;
let mgr: IngestorManager;
let daemonDir: string;
let clientDir: string;
let prevConfigDir: string | undefined;
let connections = 0;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI as a child (async: the daemon runs in this process's event loop). */
function cli(
  args: string[],
  opts: { input?: string; env?: Record<string, string | undefined>; cwd?: string } = {},
): Promise<Run> {
  return run(process.execPath, [bin, ...args], opts);
}

function run(
  cmd: string,
  args: string[],
  opts: { input?: string; env?: Record<string, string | undefined>; cwd?: string } = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        MCP_CONFIG_DIR: clientDir,
        MCP_KEY_ALIAS: undefined,
        ...opts.env,
      }).filter((e): e is [string, string] => e[1] !== undefined),
    );
    const child = spawn(cmd, args, { env, cwd: opts.cwd ?? clientDir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    // A child may exit without reading all of stdin (git does, once it has what it
    // needs); that EPIPE isn't a test failure, and the exit status is checked.
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input ?? '');
  });
}

function expectNoCanary(r: Run): void {
  for (const c of CANARIES) {
    expect(r.stdout).not.toContain(c);
    expect(r.stderr).not.toContain(c);
  }
}

function writeClientKeys(alias: string, keys: KeyBundle): void {
  saveKeyBundle(keys, path.join(clientDir, 'keys', 'callers', alias));
}

function auditLines(caller: string): Record<string, unknown>[] {
  const d = path.join(daemonDir, 'audit', caller);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const GIT_GET = 'protocol=https\nhost=forgejo.example.com\n\n';

describe.skipIf(!built)('drawlatch vault (CLI against a test daemon)', () => {
  beforeAll(async () => {
    prevConfigDir = process.env.MCP_CONFIG_DIR;
    daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-vault-cli-daemon-'));
    clientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-vault-cli-client-'));
    process.env.MCP_CONFIG_DIR = daemonDir;
    resetAuditLogState();
    resetVaultCache();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const aliceKeys = generateKeyBundle();
    const bobKeys = generateKeyBundle();
    const serverKeys = generateKeyBundle();

    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,
      connectors: [],
      callers: { alice: { connections: [] }, bob: { connections: [] } },
      rateLimitPerMinute: 1000,
    };
    saveRemoteConfig(config);
    mgr = new IngestorManager(config);
    const app = createApp({
      config,
      ownKeys: serverKeys,
      authorizedPeers: [
        { alias: 'alice', keys: extractPublicKeys(aliceKeys) },
        { alias: 'bob', keys: extractPublicKeys(bobKeys) },
      ],
      ingestorManager: mgr,
      disableRateLimiting: true,
    });
    await new Promise<void>((resolve) => {
      // Port 0: an ephemeral port, never the default 9999.
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
    server.on('connection', () => {
      connections++;
    });

    // The caller's side only: proxy config, own keys, the server's public keys.
    fs.writeFileSync(
      path.join(clientDir, 'proxy.config.json'),
      JSON.stringify({ remoteUrl: baseUrl }),
    );
    writeClientKeys('alice', aliceKeys);
    writeClientKeys('bob', bobKeys);
    const serverPub = serializeKeyBundle(serverKeys);
    fs.mkdirSync(path.join(clientDir, 'keys', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(clientDir, 'keys', 'server', 'signing.pub.pem'),
      serverPub.signing.publicKey,
    );
    fs.writeFileSync(
      path.join(clientDir, 'keys', 'server', 'exchange.pub.pem'),
      serverPub.exchange.publicKey,
    );

    await createItem(
      'alice',
      { name: 'forgejo-token', kind: 'token', values: { value: REVEAL_TOKEN }, exposure: 'reveal' },
      'agent',
    );
    await createItem(
      'alice',
      {
        name: 'forgejo-login',
        kind: 'password',
        values: { value: PASSWORD, username: 'release-bot' },
        exposure: 'reveal',
      },
      'agent',
    );
    await createItem(
      'alice',
      { name: 'inject-token', kind: 'token', values: { value: INJECT_TOKEN } },
      'agent',
    );
    await createItem(
      'alice',
      {
        name: 'multiline',
        kind: 'note',
        values: { value: `${NEWLINE_TOKEN}\nprotocol=https` },
        exposure: 'reveal',
      },
      'agent',
    );
    // bob: a reveal grant on forgejo-token, an inject grant on forgejo-login.
    const r1 = await requestAccess('bob', {
      owner: 'alice',
      name: 'forgejo-token',
      reason: 'push tags',
      mode: 'reveal',
    });
    await grantRequest(r1.requestId, { mode: 'reveal' });
    const r2 = await requestAccess('bob', {
      owner: 'alice',
      name: 'forgejo-login',
      reason: 'push tags',
    });
    await grantRequest(r2.requestId, { mode: 'inject' });
    await createItem(
      'bob',
      { name: 'bob-only', kind: 'token', values: { value: UNGRANTED }, exposure: 'reveal' },
      'agent',
    );
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await mgr.stopAll();
    vi.restoreAllMocks();
    resetVaultCache();
    if (prevConfigDir === undefined) delete process.env.MCP_CONFIG_DIR;
    else process.env.MCP_CONFIG_DIR = prevConfigDir;
    fs.rmSync(daemonDir, { recursive: true, force: true });
    fs.rmSync(clientDir, { recursive: true, force: true });
  });

  it('the client config dir holds only caller material', () => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else files.push(path.relative(clientDir, full));
      }
    };
    walk(clientDir);
    expect(files.sort()).toEqual(
      [
        'proxy.config.json',
        ...['alice', 'bob'].flatMap((a) =>
          ['exchange.key.pem', 'exchange.pub.pem', 'signing.key.pem', 'signing.pub.pem'].map((f) =>
            path.join('keys', 'callers', a, f),
          ),
        ),
        path.join('keys', 'server', 'exchange.pub.pem'),
        path.join('keys', 'server', 'signing.pub.pem'),
      ].sort(),
    );
  });

  describe('git-credential get', () => {
    it('prints username= and password= for an own reveal token (x-access-token default)', async () => {
      const r = await cli(
        [
          'vault',
          'git-credential',
          '--item',
          'forgejo-token',
          '--caller',
          'alice',
          '--host',
          'forgejo.example.com',
          'get',
        ],
        { input: GIT_GET },
      );
      expect(r).toEqual({
        status: 0,
        stdout: `username=x-access-token\npassword=${REVEAL_TOKEN}\n`,
        stderr: '',
      });
    });

    it('uses the item’s username field, else --username', async () => {
      const login = await cli(
        ['vault', 'git-credential', '--item', 'forgejo-login', '--username', 'ignored', 'get'],
        { input: GIT_GET, env: { MCP_KEY_ALIAS: 'alice' } },
      );
      expect(login.status).toBe(0);
      expect(login.stdout).toBe(`username=release-bot\npassword=${PASSWORD}\n`);
      const token = await cli(
        [
          'vault',
          'git-credential',
          '--item',
          'forgejo-token',
          '--caller',
          'alice',
          '--username',
          'ci',
          'get',
        ],
        { input: GIT_GET },
      );
      expect(token.stdout).toBe(`username=ci\npassword=${REVEAL_TOKEN}\n`);
    });

    it('records each use as vault.reveal with via "git-credential", asserted', () => {
      const reveals = auditLines('alice').filter((l) => l['drawlatch.event'] === 'vault.reveal');
      expect(reveals.length).toBeGreaterThanOrEqual(3);
      for (const l of reveals) {
        expect(l).toMatchObject({
          'drawlatch.source': 'daemon',
          'vault.actor': 'alice',
          'vault.via': 'git-credential',
          'vault.via_asserted': true,
        });
      }
      expect(JSON.stringify(auditLines('alice'))).not.toContain(REVEAL_TOKEN);
      expect(JSON.stringify(auditLines('alice'))).not.toContain(PASSWORD);
    });

    it('answers for another caller’s item granted at reveal (--owner)', async () => {
      const r = await cli(
        [
          'vault',
          'git-credential',
          '--caller',
          'bob',
          '--owner',
          'alice',
          '--item',
          'forgejo-token',
          'get',
        ],
        { input: GIT_GET },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`username=x-access-token\npassword=${REVEAL_TOKEN}\n`);
      const last = auditLines('alice')
        .filter((l) => l['drawlatch.event'] === 'vault.reveal')
        .at(-1);
      expect(last).toMatchObject({ 'vault.actor': 'bob', 'vault.via': 'git-credential' });
      expect(last?.['vault.grant_id']).toEqual(expect.any(String));
    });

    it.each([
      ['an own inject item', ['--caller', 'alice', '--item', 'inject-token'], /inject-only/],
      [
        'an item granted inject-only',
        ['--caller', 'bob', '--owner', 'alice', '--item', 'forgejo-login'],
        /inject-only/,
      ],
      [
        'an ungranted item',
        ['--caller', 'alice', '--owner', 'bob', '--item', 'bob-only'],
        /needs a grant/,
      ],
      [
        'an ungranted inject item',
        ['--caller', 'bob', '--owner', 'alice', '--item', 'inject-token'],
        /needs a grant/,
      ],
      ['a missing item', ['--caller', 'alice', '--item', 'nope'], /No vault item "nope"/],
    ])('exits 1 with no value for %s', async (_label, args, reason) => {
      const r = await cli(['vault', 'git-credential', ...args, 'get'], { input: GIT_GET });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(reason);
      expectNoCanary(r);
    });

    it('exits 1 on a value git can’t carry, without printing it', async () => {
      const r = await cli(
        ['vault', 'git-credential', '--caller', 'alice', '--item', 'multiline', 'get'],
        { input: GIT_GET },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/newline/);
      expect(r.stderr).not.toContain(NEWLINE_TOKEN);
    });

    it('exits 1 on a --host mismatch without contacting the daemon', async () => {
      const before = connections;
      const revealsBefore = auditLines('alice').length;
      for (const input of [
        'protocol=https\nhost=evil.example.net\n\n',
        'protocol=https\nhost=forgejo.example.com:8443\n\n',
        'protocol=https\n\n',
      ]) {
        const r = await cli(
          [
            'vault',
            'git-credential',
            '--caller',
            'alice',
            '--item',
            'forgejo-token',
            '--host',
            'forgejo.example.com',
            'get',
          ],
          { input },
        );
        expect(r.status).toBe(1);
        expect(r.stdout).toBe('');
        expect(r.stderr).toMatch(/not answering/);
        expectNoCanary(r);
      }
      expect(connections).toBe(before);
      expect(auditLines('alice').length).toBe(revealsBefore);
    });

    it('matches --host case-insensitively', async () => {
      const r = await cli(
        [
          'vault',
          'git-credential',
          '--caller',
          'alice',
          '--item',
          'forgejo-token',
          '--host',
          'Forgejo.Example.com',
          'get',
        ],
        { input: GIT_GET },
      );
      expect(r.status).toBe(0);
    });

    it.each([
      [['--caller', 'alice', 'get'], /--item is required/],
      [['--caller', 'alice', '--item', 'forgejo-token'], /one action/],
      [['--caller', 'alice', '--item', 'forgejo-token', 'fill'], /get, store or erase/],
      [['--caller', '../alice', '--item', 'forgejo-token', 'get'], /--caller must be/],
      [['--caller', 'alice', '--item', 'forgejo-token', '--usernme', 'x', 'get'], /Unknown/],
      [['--caller', 'nobody', '--item', 'forgejo-token', 'get'], /Caller keys not found/],
    ])('refuses bad usage %j with exit 1 and no value', async (args, reason) => {
      const before = connections;
      const r = await cli(['vault', 'git-credential', ...args], { input: GIT_GET });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(reason);
      expectNoCanary(r);
      expect(connections).toBe(before);
    });
  });

  describe('git-credential store and erase', () => {
    it.each(['store', 'erase'])(
      '%s exits 0, prints nothing and changes nothing',
      async (action) => {
        const before = connections;
        const revision = readVault().revision;
        const auditBefore = JSON.stringify(auditLines('alice'));
        const r = await cli(
          ['vault', 'git-credential', '--caller', 'alice', '--item', 'forgejo-token', action],
          {
            input: `protocol=https\nhost=forgejo.example.com\nusername=x\npassword=fake-new-0000\n\n`,
          },
        );
        expect(r).toEqual({ status: 0, stdout: '', stderr: '' });
        expect(connections).toBe(before);
        expect(readVault().revision).toBe(revision);
        expect(JSON.stringify(auditLines('alice'))).toBe(auditBefore);
      },
    );
  });

  describe('list', () => {
    it('lists names, kinds, exposure and shared items, never values', async () => {
      const alice = await cli(['vault', 'list', '--caller', 'alice']);
      expect(alice.status).toBe(0);
      expect(alice.stdout).toMatch(/^NAME\s+KIND\s+EXPOSURE\s+FIELDS$/m);
      expect(alice.stdout).toMatch(/^forgejo-token\s+token\s+reveal\s+value$/m);
      expect(alice.stdout).toMatch(/^inject-token\s+token\s+inject\s+value$/m);
      expect(alice.stdout).toMatch(/^forgejo-login\s+password\s+reveal\s+username,value$/m);
      expectNoCanary(alice);
      const bob = await cli(['vault', 'list', '--caller', 'bob']);
      expect(bob.status).toBe(0);
      expect(bob.stdout).toContain('Shared with you:');
      expect(bob.stdout).toMatch(/^alice\/forgejo-token\s+token\s+reveal\s+value$/m);
      expect(bob.stdout).toMatch(/^alice\/forgejo-login\s+password\s+inject\s+username,value$/m);
      expectNoCanary(bob);
    });
  });

  describe('help', () => {
    it('drawlatch vault --help documents both subcommands', async () => {
      const r = await cli(['vault', '--help']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('drawlatch vault list [--caller <alias>]');
      expect(r.stdout).toContain('drawlatch vault git-credential --item <name>');
      // The check that shows helper order, not the --get-all one that can't.
      expect(r.stdout).toContain("git config --show-origin --get-regexp '^credential\\..*helper$'");
      expect(r.stdout).toContain('GIT_TRACE=1 git credential reject');
      expect(r.stdout).not.toContain('--get-all');
      // The example resets inherited helpers for the URL before adding this one.
      expect(r.stdout).toContain(
        "git config --global credential.https://forgejo.example.com.helper ''",
      );
      expect(r.stdout).toContain(
        'git config --global --add credential.https://forgejo.example.com.helper',
      );
      const top = await cli(['--help']);
      expect(top.stdout).toMatch(/^\s+vault\s+/m);
    });
  });

  describe('the MCP server after the client extraction', () => {
    it('lists the vault tools and serves vault_get over stdio', async () => {
      const messages = [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'vault-cli-test', version: '0' },
          },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'vault_get', arguments: { name: 'forgejo-token' } },
        },
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'vault_get', arguments: { name: 'inject-token' } },
        },
      ];
      const responses = await mcpSession(messages);
      const tools = (responses.get(2)?.result as { tools: { name: string }[] }).tools.map(
        (t) => t.name,
      );
      expect(tools).toEqual(expect.arrayContaining(['secure_request', 'vault_get', 'vault_list']));
      const ok = responses.get(3)?.result as { content: { text: string }[]; isError?: boolean };
      expect(ok.isError).toBeUndefined();
      expect(JSON.parse(ok.content[0].text)).toMatchObject({ values: { value: REVEAL_TOKEN } });
      const refused = responses.get(4)?.result as {
        content: { text: string }[];
        isError?: boolean;
      };
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/inject-only/);
      expect(refused.content[0].text).not.toContain(INJECT_TOKEN);
      const last = auditLines('alice')
        .filter((l) => l['drawlatch.event'] === 'vault.reveal')
        .at(-1);
      expect(last).toMatchObject({ 'vault.actor': 'alice', 'vault.via': 'mcp' });
      expect(last).not.toHaveProperty('vault.via_asserted');
    });
  });

  describe.skipIf(!hasGit)('with git (throwaway HOME and global config)', () => {
    let home: string;
    let repo: string;
    const gitEnv = (): Record<string, string> => ({
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_GLOBAL: path.join(home, 'no-global-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      MCP_KEY_ALIAS: 'alice',
    });
    const helper = (host: string): string =>
      `!"${process.execPath}" "${bin}" vault git-credential --item forgejo-token --host ${host}`;

    beforeAll(async () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-vault-cli-home-'));
      repo = path.join(home, 'repo');
      fs.mkdirSync(repo);
      expect((await run('git', ['init', '-q'], { cwd: repo, env: gitEnv() })).status).toBe(0);
    });
    afterAll(() => {
      fs.rmSync(home, { recursive: true, force: true });
    });

    it('git credential fill gets the token from a URL-scoped helper; nothing is stored', async () => {
      const set = await run(
        'git',
        [
          'config',
          '--local',
          'credential.https://forgejo.example.com.helper',
          helper('forgejo.example.com'),
        ],
        { cwd: repo, env: gitEnv() },
      );
      expect(set.status).toBe(0);
      const fill = await run('git', ['credential', 'fill'], {
        cwd: repo,
        env: gitEnv(),
        input: 'protocol=https\nhost=forgejo.example.com\npath=org/repo.git\n\n',
      });
      expect(fill.status).toBe(0);
      expect(fill.stdout).toContain(`username=x-access-token\npassword=${REVEAL_TOKEN}\n`);
      // git asks its helpers to store what worked; the helper does nothing.
      const approve = await run('git', ['credential', 'approve'], {
        cwd: repo,
        env: gitEnv(),
        input: fill.stdout + '\n',
      });
      expect(approve.status).toBe(0);
      // Another host isn't answered by the scoped helper.
      const other = await run('git', ['credential', 'fill'], {
        cwd: repo,
        env: gitEnv(),
        input: 'protocol=https\nhost=other.example.com\n\n',
      });
      expect(other.stdout).not.toContain(REVEAL_TOKEN);
      expect(other.status).not.toBe(0);
      expectNoCredentialFiles(home);
    });

    /**
     * git calls `store` on every helper that applies to a URL, and a
     * URL-scoped helper is added to the inherited list (osxkeychain, manager,
     * store, cache …), not put in its place. An unscoped `store` helper in a
     * temp global config stands in for those. The documented empty `helper`
     * line clears the inherited list for the URL; without it the token lands
     * in ~/.git-credentials.
     */
    const KEY = 'credential.https://forgejo.example.com.helper';
    type GitConfig = (...args: string[]) => Promise<void>;

    /**
     * A throwaway HOME whose temp GIT_CONFIG_GLOBAL starts as `initialGlobal`;
     * `setup` runs `git config …` inside a fresh repo, then git fills and
     * approves a credential for forgejo.example.com. Returns the HOME so the
     * caller can look for ~/.git-credentials (where `store` writes).
     */
    async function fillAndApprove(
      initialGlobal: string,
      setup: (config: GitConfig) => Promise<void>,
    ): Promise<{ home: string; fill: Run }> {
      const h = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-vault-cli-store-'));
      const globalConfig = path.join(h, 'temp-global-gitconfig');
      fs.writeFileSync(globalConfig, initialGlobal);
      const env = {
        ...gitEnv(),
        HOME: h,
        XDG_CONFIG_HOME: path.join(h, '.config'),
        GIT_CONFIG_GLOBAL: globalConfig,
      };
      const r = path.join(h, 'repo');
      fs.mkdirSync(r);
      expect((await run('git', ['init', '-q'], { cwd: r, env })).status).toBe(0);
      await setup(async (...args) => {
        expect((await run('git', ['config', ...args], { cwd: r, env })).status).toBe(0);
      });
      const fill = await run('git', ['credential', 'fill'], {
        cwd: r,
        env,
        input: 'protocol=https\nhost=forgejo.example.com\n\n',
      });
      expect(fill.status).toBe(0);
      const approve = await run('git', ['credential', 'approve'], {
        cwd: r,
        env,
        input: fill.stdout + '\n',
      });
      expect(approve.status).toBe(0);
      return { home: h, fill };
    }

    const EARLIER_STORE = '[credential]\n\thelper = store\n';
    const resetAndAdd =
      (scope: '--global' | '--local') =>
      async (config: GitConfig): Promise<void> => {
        await config(scope, KEY, '');
        await config(scope, '--add', KEY, helper('forgejo.example.com'));
      };

    it.each([
      ['the documented --global lines, store above them in the same file', resetAndAdd('--global')],
      ['repo-local reset lines, store in the global file', resetAndAdd('--local')],
    ])(
      'with the reset line, an earlier store helper writes nothing (%s)',
      async (_label, setup) => {
        const { home: h, fill } = await fillAndApprove(EARLIER_STORE, setup);
        try {
          expect(fill.stdout).toContain(`password=${REVEAL_TOKEN}\n`);
          expect(fs.existsSync(path.join(h, '.git-credentials'))).toBe(false);
          expectNoCredentialFiles(h);
        } finally {
          fs.rmSync(h, { recursive: true, force: true });
        }
      },
    );

    // The reset clears only helpers git has read before it. These pin what the
    // README says it doesn't cover, next to the control without any reset.
    it.each([
      [
        'without the reset line',
        EARLIER_STORE,
        async (config: GitConfig) => config('--local', '--add', KEY, helper('forgejo.example.com')),
      ],
      [
        'with the reset line, but a general store helper added later in the same file',
        '',
        async (config: GitConfig) => {
          await resetAndAdd('--global')(config);
          await config('--global', 'credential.helper', 'store');
        },
      ],
      [
        "with the reset line, but a general store helper in the repo's .git/config",
        '',
        async (config: GitConfig) => {
          await resetAndAdd('--global')(config);
          await config('--local', 'credential.helper', 'store');
        },
      ],
    ])('%s, the store helper persists the token', async (_label, initialGlobal, setup) => {
      const { home: h, fill } = await fillAndApprove(initialGlobal, setup);
      try {
        expect(fill.stdout).toContain(`password=${REVEAL_TOKEN}\n`);
        const stored = path.join(h, '.git-credentials');
        expect(fs.existsSync(stored)).toBe(true);
        expect(fs.readFileSync(stored, 'utf8')).toContain(REVEAL_TOKEN);
      } finally {
        fs.rmSync(h, { recursive: true, force: true });
      }
    });

    it('git fetch over HTTP sends the vault token as Basic auth', async () => {
      const seen: (string | undefined)[] = [];
      const upstream = http.createServer((req, res) => {
        seen.push(req.headers.authorization);
        if (!req.headers.authorization) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }).end();
        } else {
          res.writeHead(404).end();
        }
      });
      await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
      const hostPort = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      try {
        await run(
          'git',
          ['config', '--local', `credential.http://${hostPort}.helper`, helper(hostPort)],
          { cwd: repo, env: gitEnv() },
        );
        const ls = await run('git', ['ls-remote', `http://${hostPort}/org/repo.git`], {
          cwd: repo,
          env: gitEnv(),
        });
        expect(ls.status).not.toBe(0); // the test server has no repository
        const expected = `Basic ${Buffer.from(`x-access-token:${REVEAL_TOKEN}`).toString('base64')}`;
        expect(seen).toContain(expected);
        expect(ls.stdout + ls.stderr).not.toContain(REVEAL_TOKEN);
        expectNoCredentialFiles(home);
      } finally {
        upstream.closeAllConnections();
        await new Promise<void>((r) => upstream.close(() => r()));
      }
    });
  });
});

/** No git credential store/cache file anywhere under the throwaway HOME. */
function expectNoCredentialFiles(home: string): void {
  const offenders: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/credential/i.test(e.name) || fs.readFileSync(full).includes(REVEAL_TOKEN)) {
        offenders.push(path.relative(home, full));
      }
    }
  };
  walk(home);
  expect(offenders).toEqual([]);
}

/** Talk JSON-RPC to dist/mcp/server.js over stdio as alice, collecting responses by id. */
function mcpSession(
  messages: object[],
): Promise<Map<number, { result?: unknown; error?: unknown }>> {
  const expected = messages.filter((m) => 'id' in m).length;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'dist/mcp/server.js')], {
      env: { ...process.env, MCP_CONFIG_DIR: clientDir, MCP_KEY_ALIAS: 'alice' },
    });
    const out = new Map<number, { result?: unknown; error?: unknown }>();
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP server timed out; stderr:\n${stderr}`));
    }, 20_000);
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (typeof msg.id === 'number') out.set(msg.id, msg);
        if (out.size === expected) {
          clearTimeout(timer);
          child.kill();
          resolve(out);
        }
      }
    });
    child.on('error', reject);
    // One at a time, so the calls run in order.
    let i = 0;
    const next = (): void => {
      if (i >= messages.length) return;
      child.stdin.write(JSON.stringify(messages[i++]) + '\n');
      setTimeout(next, 50);
    };
    next();
  });
}

describe('git request reading (in process)', () => {
  /** stdin that git has written to but not closed. */
  function openStdin(text: string): PassThrough {
    const p = new PassThrough();
    p.write(text);
    return p;
  }
  const io = (stdin: PassThrough, connect = vi.fn()) => ({
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connect,
  });

  it.each([
    ['LF', 'protocol=https\nhost=forgejo.example.com\n\n'],
    ['CRLF', 'protocol=https\r\nhost=forgejo.example.com\r\n\r\n'],
    ['bare CRLF', '\r\n'],
  ])('stops at a %s blank line without waiting for EOF', async (_label, text) => {
    const connect = vi.fn();
    const code = await runVaultCli(
      ['git-credential', '--item', 'forgejo-token', 'store'],
      io(openStdin(text), connect),
    );
    expect(code).toBe(0);
    expect(connect).not.toHaveBeenCalled();
  });

  it('answers a CRLF request for the matching host, stdin still open', async () => {
    const send = vi.fn().mockResolvedValue({ values: { value: 'fake-crlf-0000' } });
    const connect = vi.fn(() => ({ send }));
    const streams = io(openStdin('protocol=https\r\nhost=forgejo.example.com\r\n\r\n'), connect);
    const code = await runVaultCli(
      ['git-credential', '--item', 'forgejo-token', '--host', 'forgejo.example.com', 'get'],
      streams,
    );
    expect(code).toBe(0);
    expect(send).toHaveBeenCalledWith('vault_get', {
      name: 'forgejo-token',
      purpose: 'git-credential',
    });
    expect(String(streams.stdout.read())).toBe(
      'username=x-access-token\npassword=fake-crlf-0000\n',
    );
  });

  it('refuses a CRLF request for another host without connecting, stdin still open', async () => {
    const connect = vi.fn();
    const code = await runVaultCli(
      ['git-credential', '--item', 'forgejo-token', '--host', 'forgejo.example.com', 'get'],
      io(openStdin('protocol=https\r\nhost=evil.example.net\r\n\r\n'), connect),
    );
    expect(code).toBe(1);
    expect(connect).not.toHaveBeenCalled();
  });

  it('gives up after 64 KiB without a blank line, stdin still open', async () => {
    const connect = vi.fn();
    const streams = io(openStdin(`host=forgejo.example.com\n${'a'.repeat(70_000)}`), connect);
    const code = await runVaultCli(
      ['git-credential', '--item', 'forgejo-token', '--host', 'forgejo.example.com', 'get'],
      streams,
    );
    expect(code).toBe(1);
    expect(String(streams.stderr.read())).toMatch(/more input than expected/);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('git request parsing', () => {
  it('reads key=value lines up to the blank line and skips array keys', () => {
    const m = parseGitRequest(
      'protocol=https\r\nhost=forgejo.example.com\ncapability[]=authtype\nwwwauth[]=Basic\n\nhost=late.example.com\n',
    );
    expect(Object.fromEntries(m)).toEqual({ protocol: 'https', host: 'forgejo.example.com' });
  });
});

/**
 * The CLI authenticates only through the caller handshake: everything
 * `drawlatch vault` loads at runtime (src/cli/vault.ts and its transitive
 * relative imports, type-only imports aside) stays out of the daemon's code
 * (src/remote/, src/auth/), never names the vault files or the admin
 * password, and never calls the admin API.
 */
describe('drawlatch vault source scan', () => {
  // Built from parts so this file doesn't trip the vault canary sweep's own scan.
  const VAULT_FILE = ['vault', 'enc', 'json'].join('.');
  const VAULT_KEY = ['vault', 'key'].join('.');

  function runtimeGraph(entry: string): string[] {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = fs.readFileSync(file, 'utf8');
      // Type-only imports are erased at build time, so they aren't followed.
      const specs = [
        ...text.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?'(\.[^']+)'/gm),
      ].map((m) => m[1]);
      for (const m of text.matchAll(/\bimport\(\s*'(\.[^']+)'\s*\)/g)) specs.push(m[1]);
      for (const spec of specs) {
        visit(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')));
      }
    };
    visit(entry);
    return [...seen].map((f) => path.relative(repoRoot, f)).sort();
  }

  const graph = runtimeGraph(path.join(repoRoot, 'src', 'cli', 'vault.ts'));

  it('loads the channel client and shared code only', () => {
    expect(graph).toContain('src/mcp/client.ts');
    expect(graph).toContain('src/shared/protocol/handshake.ts');
    expect(graph).not.toContain('src/mcp/server.ts');
    // shared/connections.ts uses the allowlist matcher, a leaf module with no imports.
    expect(graph.filter((f) => !f.startsWith('src/shared/') && !f.startsWith('src/mcp/'))).toEqual([
      'src/cli/vault.ts',
      'src/remote/url-policy.ts',
    ]);
    expect(fs.readFileSync(path.join(repoRoot, 'src/remote/url-policy.ts'), 'utf8')).not.toMatch(
      /^\s*import\s/m,
    );
    expect(graph.some((f) => f.startsWith('src/remote/vault/') || f.startsWith('src/auth/'))).toBe(
      false,
    );
  });

  it('no file it loads names the vault files, the admin password or the admin API', () => {
    const offenders = graph.filter((f) => {
      const text = fs.readFileSync(path.join(repoRoot, f), 'utf8');
      return (
        text.includes(VAULT_FILE) ||
        text.includes(VAULT_KEY) ||
        /AUTH_PASSWORD|\/api\/admin|\/auth\/login/.test(text)
      );
    });
    expect(offenders).toEqual([]);
  });

  it('calls only vault_list and vault_get, over the client', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src', 'cli', 'vault.ts'), 'utf8');
    expect([...src.matchAll(/\.send\('([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([
      'vault_get',
      'vault_list',
    ]);
    expect(src).not.toMatch(/\bfetch\(|node:fs|node:http|readFile/);
    // The only places the channel client goes on the network.
    const client = fs.readFileSync(path.join(repoRoot, 'src', 'mcp', 'client.ts'), 'utf8');
    expect([...client.matchAll(/\$\{remoteUrl\}(\/[a-z/]+)/g)].map((m) => m[1]).sort()).toEqual([
      '/handshake/finish',
      '/handshake/init',
      '/request',
    ]);
  });

  it('bin/drawlatch.js loads the vault store only inside doctor, and vault only from dist/cli/vault.js', () => {
    const binSrc = fs.readFileSync(bin, 'utf8');
    const vaultCase = binSrc.slice(binSrc.indexOf('case "vault"'), binSrc.indexOf('case "watch"'));
    expect([...vaultCase.matchAll(/dist\/[\w/.-]+/g)].map((m) => m[0])).toEqual([
      'dist/cli/vault.js',
    ]);
    const storeImports = [...binSrc.matchAll(/dist\/remote\/vault\/store\.js/g)].map(
      (m) => m.index,
    );
    const doctor = binSrc.indexOf('async function cmdDoctor()');
    const afterDoctor = binSrc.indexOf('\nasync function ', doctor + 1);
    expect(storeImports.length).toBe(1);
    expect(storeImports[0]).toBeGreaterThan(doctor);
    expect(storeImports[0]).toBeLessThan(afterDoctor);
  });
});
