/**
 * Unit tests for the IngestorManager.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { IngestorManager, makeKey, parseKey, DEFAULT_INSTANCE_ID } from './manager.js';
import { resetSharedTokenManager } from '../oauth/shared-token-manager.js';
import type { RemoteServerConfig } from '../../shared/config.js';
import type { IngestorConfig } from './types.js';
import type { IngestorOverrides, ListenerConfigField } from '../../shared/config.js';

describe('IngestorManager', () => {
  it('should return empty events for a caller with no ingestors', () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      callers: {
        'test-caller': { connections: [] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);

    expect(manager.getAllEvents('test-caller')).toEqual([]);
    expect(manager.getStatuses('test-caller')).toEqual([]);
  });

  it('should return empty events for an unknown caller', () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      callers: {},
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);

    expect(manager.getAllEvents('nonexistent')).toEqual([]);
    expect(manager.getEvents('nonexistent', 'discord-bot')).toEqual([]);
    expect(manager.getStatuses('nonexistent')).toEqual([]);
  });

  it('should return empty events for a caller with connections but no ingestors', () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        {
          alias: 'no-ingestor-route',
          secrets: { TOKEN: 'value' },
          allowedEndpoints: ['https://example.com/**'],
        },
      ],
      callers: {
        'test-caller': { connections: ['no-ingestor-route'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);

    expect(manager.getAllEvents('test-caller')).toEqual([]);
    expect(manager.getStatuses('test-caller')).toEqual([]);
  });

  it('should start and stop without errors when no ingestors are configured', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      callers: {},
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);

    await expect(manager.startAll()).resolves.toBeUndefined();
    await expect(manager.stopAll()).resolves.toBeUndefined();
  });
});

describe('IngestorManager.mergeIngestorConfig', () => {
  const baseConfig: IngestorConfig = {
    type: 'websocket',
    websocket: {
      gatewayUrl: 'wss://gateway.discord.gg/?v=10&encoding=json',
      protocol: 'discord',
      intents: 3276799,
    },
  };

  it('should return template config unchanged when no overrides provided', () => {
    const result = IngestorManager.mergeIngestorConfig(baseConfig, undefined);
    expect(result).toEqual(baseConfig);
  });

  it('should return template config unchanged when overrides is empty object', () => {
    const result = IngestorManager.mergeIngestorConfig(baseConfig, {});
    expect(result.websocket?.intents).toBe(3276799);
    expect(result.websocket?.eventFilter).toBeUndefined();
    expect(result.websocket?.guildIds).toBeUndefined();
    expect(result.websocket?.channelIds).toBeUndefined();
    expect(result.websocket?.userIds).toBeUndefined();
  });

  it('should override intents', () => {
    const overrides: IngestorOverrides = { intents: 4609 };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.websocket?.intents).toBe(4609);
  });

  it('should override eventFilter', () => {
    const overrides: IngestorOverrides = { eventFilter: ['MESSAGE_CREATE'] };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.websocket?.eventFilter).toEqual(['MESSAGE_CREATE']);
  });

  it('should override guildIds', () => {
    const overrides: IngestorOverrides = { guildIds: ['123', '456'] };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.websocket?.guildIds).toEqual(['123', '456']);
  });

  it('should override channelIds', () => {
    const overrides: IngestorOverrides = { channelIds: ['789'] };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.websocket?.channelIds).toEqual(['789']);
  });

  it('should override userIds', () => {
    const overrides: IngestorOverrides = { userIds: ['user1', 'user2'] };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.websocket?.userIds).toEqual(['user1', 'user2']);
  });

  it('should override multiple fields at once', () => {
    const overrides: IngestorOverrides = {
      intents: 512,
      eventFilter: ['MESSAGE_CREATE', 'MESSAGE_UPDATE'],
      guildIds: ['111'],
      channelIds: ['222'],
      userIds: ['333'],
    };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.websocket?.intents).toBe(512);
    expect(result.websocket?.eventFilter).toEqual(['MESSAGE_CREATE', 'MESSAGE_UPDATE']);
    expect(result.websocket?.guildIds).toEqual(['111']);
    expect(result.websocket?.channelIds).toEqual(['222']);
    expect(result.websocket?.userIds).toEqual(['333']);
  });

  it('should not mutate the original template config', () => {
    const overrides: IngestorOverrides = { intents: 1, guildIds: ['999'] };
    IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    // Original should be unchanged
    expect(baseConfig.websocket?.intents).toBe(3276799);
    expect(baseConfig.websocket?.guildIds).toBeUndefined();
  });

  it('should preserve non-overridden template fields', () => {
    const overrides: IngestorOverrides = { guildIds: ['123'] };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.type).toBe('websocket');
    expect(result.websocket?.gatewayUrl).toBe('wss://gateway.discord.gg/?v=10&encoding=json');
    expect(result.websocket?.protocol).toBe('discord');
    expect(result.websocket?.intents).toBe(3276799);
  });

  it('should handle config without websocket block gracefully', () => {
    const webhookConfig: IngestorConfig = {
      type: 'webhook',
      webhook: { path: 'github' },
    };
    const overrides: IngestorOverrides = { intents: 4609, guildIds: ['123'] };
    const result = IngestorManager.mergeIngestorConfig(webhookConfig, overrides);
    // Should not crash; websocket overrides are ignored for non-websocket types
    expect(result.type).toBe('webhook');
    expect(result.webhook?.path).toBe('github');
    expect(result.websocket).toBeUndefined();
  });
});

describe('IngestorManager.has', () => {
  it('should return false when no ingestor exists', () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      callers: {
        'test-caller': { connections: [] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    expect(manager.has('test-caller', 'discord-bot')).toBe(false);
  });

  it('should return false for unknown caller', () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      callers: {},
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    expect(manager.has('nonexistent', 'discord-bot')).toBe(false);
  });
});

describe('IngestorManager.stopOne', () => {
  it('should return error when no ingestor is running', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      callers: {
        'test-caller': { connections: [] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.stopOne('test-caller', 'discord-bot');
    expect(result.success).toBe(false);
    expect(result.connection).toBe('discord-bot');
    expect(result.error).toContain('No ingestor running');
  });
});

describe('IngestorManager.startOne', () => {
  it('should return error for unknown caller', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      callers: {},
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.startOne('nonexistent', 'discord-bot');
    expect(result.success).toBe(false);
    expect(result.connection).toBe('discord-bot');
    expect(result.error).toContain('Unknown caller');
  });

  it('should return error when caller does not have the connection', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      callers: {
        'test-caller': { connections: ['other-connection'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.startOne('test-caller', 'discord-bot');
    expect(result.success).toBe(false);
    expect(result.connection).toBe('discord-bot');
    expect(result.error).toContain('Caller does not have connection');
  });

  it('should return error when connection has no ingestor config', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        {
          alias: 'no-ingestor',
          secrets: { TOKEN: 'value' },
          allowedEndpoints: ['https://example.com/**'],
        },
      ],
      callers: {
        'test-caller': { connections: ['no-ingestor'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.startOne('test-caller', 'no-ingestor');
    expect(result.success).toBe(false);
    expect(result.connection).toBe('no-ingestor');
    expect(result.error).toContain('does not have an ingestor');
  });
});

describe('IngestorManager.restartOne', () => {
  it('should call startOne when no ingestor exists (returns error for missing config)', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      callers: {
        'test-caller': { connections: [] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.restartOne('test-caller', 'discord-bot');
    // restartOne delegates to startOne, which fails because the caller doesn't have this connection
    expect(result.success).toBe(false);
    expect(result.connection).toBe('discord-bot');
  });

  it('should return error for unknown caller', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      callers: {},
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.restartOne('unknown', 'discord-bot');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown caller');
  });
});

describe('IngestorManager — webhook ingestor lifecycle', () => {
  it('should successfully start a webhook ingestor', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        {
          alias: 'github',
          secrets: { GITHUB_TOKEN: 'ghp_test', GITHUB_WEBHOOK_SECRET: 'secret123' },
          allowedEndpoints: ['https://api.github.com/**'],
          ingestor: {
            type: 'webhook',
            webhook: {
              path: 'github',
              signatureHeader: 'X-Hub-Signature-256',
              signatureSecret: 'GITHUB_WEBHOOK_SECRET',
            },
          },
        },
      ],
      callers: {
        'test-caller': { connections: ['github'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.startOne('test-caller', 'github');
    expect(result.success).toBe(true);
    expect(result.connection).toBe('github');
    expect(result.state).toBe('connected');
    expect(manager.has('test-caller', 'github')).toBe(true);

    // Stop it
    const stopResult = await manager.stopOne('test-caller', 'github');
    expect(stopResult.success).toBe(true);
    expect(stopResult.state).toBe('stopped');
    expect(manager.has('test-caller', 'github')).toBe(false);
  });

  it('should return already-running status when starting a running ingestor', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        {
          alias: 'github',
          secrets: { GITHUB_TOKEN: 'ghp_test', GITHUB_WEBHOOK_SECRET: 'secret123' },
          allowedEndpoints: ['https://api.github.com/**'],
          ingestor: {
            type: 'webhook',
            webhook: {
              path: 'github',
              signatureHeader: 'X-Hub-Signature-256',
              signatureSecret: 'GITHUB_WEBHOOK_SECRET',
            },
          },
        },
      ],
      callers: {
        'test-caller': { connections: ['github'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    await manager.startOne('test-caller', 'github');

    // Start again — should return success with current state
    const result = await manager.startOne('test-caller', 'github');
    expect(result.success).toBe(true);
    expect(result.state).toBe('connected');

    await manager.stopOne('test-caller', 'github');
  });

  it('should restart a webhook ingestor', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        {
          alias: 'github',
          secrets: { GITHUB_TOKEN: 'ghp_test', GITHUB_WEBHOOK_SECRET: 'secret123' },
          allowedEndpoints: ['https://api.github.com/**'],
          ingestor: {
            type: 'webhook',
            webhook: {
              path: 'github',
              signatureHeader: 'X-Hub-Signature-256',
              signatureSecret: 'GITHUB_WEBHOOK_SECRET',
            },
          },
        },
      ],
      callers: {
        'test-caller': { connections: ['github'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    await manager.startOne('test-caller', 'github');

    const result = await manager.restartOne('test-caller', 'github');
    expect(result.success).toBe(true);
    expect(result.connection).toBe('github');
    expect(manager.has('test-caller', 'github')).toBe(true);

    await manager.stopOne('test-caller', 'github');
  });

  it('should handle getWebhookIngestors for started webhook ingestors', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        {
          alias: 'github',
          secrets: { GITHUB_TOKEN: 'ghp_test', GITHUB_WEBHOOK_SECRET: 'secret123' },
          allowedEndpoints: ['https://api.github.com/**'],
          ingestor: {
            type: 'webhook',
            webhook: {
              path: 'github',
              signatureHeader: 'X-Hub-Signature-256',
              signatureSecret: 'GITHUB_WEBHOOK_SECRET',
            },
          },
        },
      ],
      callers: {
        'test-caller': { connections: ['github'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    await manager.startOne('test-caller', 'github');

    const webhookIngestors = manager.getWebhookIngestors('github');
    expect(webhookIngestors).toHaveLength(1);

    const nonexistent = manager.getWebhookIngestors('nonexistent');
    expect(nonexistent).toHaveLength(0);

    await manager.stopOne('test-caller', 'github');
  });
});

describe('IngestorManager.mergeIngestorConfig — poll overrides', () => {
  const pollConfig: IngestorConfig = {
    type: 'poll',
    poll: {
      url: 'https://api.example.com/items',
      intervalMs: 60_000,
      method: 'POST',
      body: { query: 'test' },
      deduplicateBy: 'id',
      responsePath: 'results',
      eventType: 'item_updated',
    },
  };

  it('should override intervalMs for poll config', () => {
    const overrides: IngestorOverrides = { intervalMs: 30_000 };
    const result = IngestorManager.mergeIngestorConfig(pollConfig, overrides);
    expect(result.poll?.intervalMs).toBe(30_000);
  });

  it('should not mutate original poll config', () => {
    const overrides: IngestorOverrides = { intervalMs: 15_000 };
    IngestorManager.mergeIngestorConfig(pollConfig, overrides);
    expect(pollConfig.poll?.intervalMs).toBe(60_000);
  });

  it('should preserve non-overridden poll fields', () => {
    const overrides: IngestorOverrides = { intervalMs: 30_000 };
    const result = IngestorManager.mergeIngestorConfig(pollConfig, overrides);
    expect(result.type).toBe('poll');
    expect(result.poll?.url).toBe('https://api.example.com/items');
    expect(result.poll?.method).toBe('POST');
    expect(result.poll?.deduplicateBy).toBe('id');
    expect(result.poll?.responsePath).toBe('results');
    expect(result.poll?.eventType).toBe('item_updated');
  });

  it('should handle poll config without overrides', () => {
    const result = IngestorManager.mergeIngestorConfig(pollConfig, undefined);
    expect(result).toEqual(pollConfig);
  });

  it('should handle poll config with empty overrides', () => {
    const result = IngestorManager.mergeIngestorConfig(pollConfig, {});
    expect(result.poll?.intervalMs).toBe(60_000);
  });

  it('should not apply websocket overrides to poll config', () => {
    const overrides: IngestorOverrides = { intents: 4609, guildIds: ['123'] };
    const result = IngestorManager.mergeIngestorConfig(pollConfig, overrides);
    // Should not crash; websocket overrides are ignored for poll types
    expect(result.type).toBe('poll');
    expect(result.poll?.intervalMs).toBe(60_000);
    expect(result.websocket).toBeUndefined();
  });
});

// ── Multi-instance key helpers ──────────────────────────────────────────

describe('makeKey / parseKey', () => {
  it('should build a composite key with default instance', () => {
    expect(makeKey('alice', 'github')).toBe(`alice:github:${DEFAULT_INSTANCE_ID}`);
  });

  it('should build a composite key with explicit instance', () => {
    expect(makeKey('alice', 'trello', 'project-board')).toBe('alice:trello:project-board');
  });

  it('should round-trip through parseKey (default instance)', () => {
    const key = makeKey('bob', 'reddit');
    const parsed = parseKey(key);
    expect(parsed.caller).toBe('bob');
    expect(parsed.connection).toBe('reddit');
    expect(parsed.instance).toBe(DEFAULT_INSTANCE_ID);
  });

  it('should round-trip through parseKey (explicit instance)', () => {
    const key = makeKey('bob', 'trello', 'design-board');
    const parsed = parseKey(key);
    expect(parsed.caller).toBe('bob');
    expect(parsed.connection).toBe('trello');
    expect(parsed.instance).toBe('design-board');
  });

  it('should handle instance IDs containing colons', () => {
    const key = makeKey('alice', 'github', 'org:repo');
    const parsed = parseKey(key);
    expect(parsed.caller).toBe('alice');
    expect(parsed.connection).toBe('github');
    expect(parsed.instance).toBe('org:repo');
  });

  it('should export DEFAULT_INSTANCE_ID as _default', () => {
    expect(DEFAULT_INSTANCE_ID).toBe('_default');
  });
});

// ── applyInstanceParams ────────────────────────────────────────────────

describe('IngestorManager.applyInstanceParams', () => {
  it('should inject overrideKey params as secrets', () => {
    const config: IngestorConfig = {
      type: 'poll',
      poll: { url: 'https://example.com/r/${SUBREDDIT}/new', intervalMs: 60000 },
    };
    const secrets: Record<string, string> = { SOME_TOKEN: 'abc' };
    const params = { subreddit: 'rust' };
    const fields: ListenerConfigField[] = [
      { key: 'subreddit', label: 'Subreddit', type: 'text', overrideKey: 'SUBREDDIT' },
    ];

    IngestorManager.applyInstanceParams(config, secrets, params, fields);

    expect(secrets.SUBREDDIT).toBe('rust');
    expect(secrets.SOME_TOKEN).toBe('abc'); // original preserved
  });

  it('should attach instanceKey params to webhook config', () => {
    const config: IngestorConfig = {
      type: 'webhook',
      webhook: { path: 'trello' },
    };
    const secrets: Record<string, string> = {};
    const params = { boardId: 'abc123' };
    const fields: ListenerConfigField[] = [
      { key: 'boardId', label: 'Board ID', type: 'text', instanceKey: true },
    ];

    IngestorManager.applyInstanceParams(config, secrets, params, fields);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    expect((config.webhook as any)._boardId).toBe('abc123');
  });

  it('should handle both overrideKey and instanceKey on the same field', () => {
    const config: IngestorConfig = {
      type: 'webhook',
      webhook: { path: 'test' },
    };
    const secrets: Record<string, string> = {};
    const params = { channelId: 'C12345' };
    const fields: ListenerConfigField[] = [
      {
        key: 'channelId',
        label: 'Channel',
        type: 'text',
        instanceKey: true,
        overrideKey: 'CHANNEL_ID',
      },
    ];

    IngestorManager.applyInstanceParams(config, secrets, params, fields);

    expect(secrets.CHANNEL_ID).toBe('C12345');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    expect((config.webhook as any)._channelId).toBe('C12345');
  });

  it('should skip params that do not match any field', () => {
    const config: IngestorConfig = {
      type: 'webhook',
      webhook: { path: 'test' },
    };
    const secrets: Record<string, string> = {};
    const params = { unknownParam: 'value' };
    const fields: ListenerConfigField[] = [
      { key: 'boardId', label: 'Board ID', type: 'text', instanceKey: true },
    ];

    IngestorManager.applyInstanceParams(config, secrets, params, fields);

    expect(Object.keys(secrets)).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    expect((config.webhook as any)._unknownParam).toBeUndefined();
  });

  it('should not inject overrideKey for non-string param values', () => {
    const config: IngestorConfig = {
      type: 'poll',
      poll: { url: 'https://example.com', intervalMs: 60000 },
    };
    const secrets: Record<string, string> = {};
    const params = { count: 42 };
    const fields: ListenerConfigField[] = [
      { key: 'count', label: 'Count', type: 'number', overrideKey: 'COUNT_VAR' },
    ];

    IngestorManager.applyInstanceParams(config, secrets, params, fields);

    // overrideKey only applies to string values
    expect(secrets.COUNT_VAR).toBeUndefined();
  });
});

// ── Multi-instance webhook lifecycle ─────────────────────────────────────

describe('IngestorManager — multi-instance webhook lifecycle', () => {
  const makeMultiInstanceConfig = (): RemoteServerConfig => ({
    host: '127.0.0.1',
    port: 9999,
    connectors: [
      {
        alias: 'github',
        secrets: { GITHUB_TOKEN: 'ghp_test', GITHUB_WEBHOOK_SECRET: 'secret123' },
        allowedEndpoints: ['https://api.github.com/**'],
        ingestor: {
          type: 'webhook',
          webhook: {
            path: 'github',
            signatureHeader: 'X-Hub-Signature-256',
            signatureSecret: 'GITHUB_WEBHOOK_SECRET',
          },
        },
        listenerConfig: {
          name: 'GitHub Webhook Listener',
          supportsMultiInstance: true,
          fields: [
            {
              key: 'repoFilter',
              label: 'Repo Filter',
              type: 'text[]',
              instanceKey: true,
              group: 'Filtering',
            },
            { key: 'eventFilter', label: 'Events', type: 'multiselect', group: 'Filtering' },
            { key: 'bufferSize', label: 'Buffer Size', type: 'number', group: 'Advanced' },
          ],
        },
      },
    ],
    callers: {
      'test-caller': {
        connections: ['github'],
        listenerInstances: {
          github: {
            'frontend-repo': {
              params: { repoFilter: ['org/frontend'] },
            },
            'backend-repo': {
              params: { repoFilter: ['org/backend'] },
            },
          },
        },
      },
    },
    rateLimitPerMinute: 60,
  });

  it('should start multiple webhook instances via startAll', async () => {
    const config = makeMultiInstanceConfig();
    const manager = new IngestorManager(config);
    await manager.startAll();

    // Both instances should exist
    expect(manager.has('test-caller', 'github', 'frontend-repo')).toBe(true);
    expect(manager.has('test-caller', 'github', 'backend-repo')).toBe(true);

    // has() without instanceId should find any instance
    expect(manager.has('test-caller', 'github')).toBe(true);

    // getWebhookIngestors should return both
    const webhookIngestors = manager.getWebhookIngestors('github');
    expect(webhookIngestors).toHaveLength(2);

    await manager.stopAll();
  });

  it('should start a specific instance via startOne with instanceId', async () => {
    const config = makeMultiInstanceConfig();
    const manager = new IngestorManager(config);

    const result = await manager.startOne('test-caller', 'github', 'frontend-repo');
    expect(result).not.toBeInstanceOf(Array);
    const singleResult = result as {
      success: boolean;
      connection: string;
      instanceId?: string;
      state?: string;
    };
    expect(singleResult.success).toBe(true);
    expect(singleResult.instanceId).toBe('frontend-repo');

    expect(manager.has('test-caller', 'github', 'frontend-repo')).toBe(true);
    expect(manager.has('test-caller', 'github', 'backend-repo')).toBe(false);

    await manager.stopAll();
  });

  it('should start all instances when startOne is called without instanceId', async () => {
    const config = makeMultiInstanceConfig();
    const manager = new IngestorManager(config);

    const result = await manager.startOne('test-caller', 'github');
    // When listenerInstances are defined and no instanceId, returns array
    expect(Array.isArray(result)).toBe(true);
    const results = result as { success: boolean }[];
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);

    await manager.stopAll();
  });

  it('should stop a specific instance', async () => {
    const config = makeMultiInstanceConfig();
    const manager = new IngestorManager(config);
    await manager.startAll();

    const result = await manager.stopOne('test-caller', 'github', 'frontend-repo');
    const singleResult = result as { success: boolean; state?: string };
    expect(singleResult.success).toBe(true);
    expect(singleResult.state).toBe('stopped');

    expect(manager.has('test-caller', 'github', 'frontend-repo')).toBe(false);
    expect(manager.has('test-caller', 'github', 'backend-repo')).toBe(true);

    await manager.stopAll();
  });

  it('should stop all instances when stopOne is called without instanceId', async () => {
    const config = makeMultiInstanceConfig();
    const manager = new IngestorManager(config);
    await manager.startAll();

    const result = await manager.stopOne('test-caller', 'github');
    // Two instances → returns array
    expect(Array.isArray(result)).toBe(true);
    const results = result as { success: boolean }[];
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);

    expect(manager.has('test-caller', 'github')).toBe(false);
  });

  it('should get statuses for multi-instance ingestors', async () => {
    const config = makeMultiInstanceConfig();
    const manager = new IngestorManager(config);
    await manager.startAll();

    const statuses = manager.getStatuses('test-caller');
    expect(statuses).toHaveLength(2);

    const instanceIds = statuses.map((s) => s.instanceId).sort();
    expect(instanceIds).toEqual(['backend-repo', 'frontend-repo']);

    for (const status of statuses) {
      expect(status.connection).toBe('github');
      expect(status.state).toBe('connected');
    }

    await manager.stopAll();
  });

  it('should skip disabled instances in listenerInstances', async () => {
    const config = makeMultiInstanceConfig();
    // Disable the backend-repo instance
    config.callers['test-caller'].listenerInstances!.github['backend-repo'].disabled = true;

    const manager = new IngestorManager(config);
    await manager.startAll();

    expect(manager.has('test-caller', 'github', 'frontend-repo')).toBe(true);
    expect(manager.has('test-caller', 'github', 'backend-repo')).toBe(false);

    const webhookIngestors = manager.getWebhookIngestors('github');
    expect(webhookIngestors).toHaveLength(1);

    await manager.stopAll();
  });

  it('should restart a specific instance', async () => {
    const config = makeMultiInstanceConfig();
    const manager = new IngestorManager(config);
    await manager.startAll();

    const result = await manager.restartOne('test-caller', 'github', 'frontend-repo');
    const singleResult = result as { success: boolean; instanceId?: string; state?: string };
    expect(singleResult.success).toBe(true);
    expect(singleResult.instanceId).toBe('frontend-repo');

    // Both should still be running
    expect(manager.has('test-caller', 'github', 'frontend-repo')).toBe(true);
    expect(manager.has('test-caller', 'github', 'backend-repo')).toBe(true);

    await manager.stopAll();
  });
});

// ── Backward compatibility (single-instance with listenerInstances absent) ──

describe('IngestorManager — backward compatibility', () => {
  it('should work normally when no listenerInstances are defined', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        {
          alias: 'github',
          secrets: { GITHUB_TOKEN: 'ghp_test', GITHUB_WEBHOOK_SECRET: 'secret123' },
          allowedEndpoints: ['https://api.github.com/**'],
          ingestor: {
            type: 'webhook',
            webhook: {
              path: 'github',
              signatureHeader: 'X-Hub-Signature-256',
              signatureSecret: 'GITHUB_WEBHOOK_SECRET',
            },
          },
        },
      ],
      callers: {
        'test-caller': { connections: ['github'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    await manager.startAll();

    expect(manager.has('test-caller', 'github')).toBe(true);
    const statuses = manager.getStatuses('test-caller');
    expect(statuses).toHaveLength(1);
    expect(statuses[0].instanceId).toBeUndefined();

    await manager.stopAll();
  });
});

// ── Webhook lifecycle: permanent stop and instanceKey secrets ────────────

describe('IngestorManager — webhook lifecycle permanent stop', () => {
  const makeWebhookConfig = (): RemoteServerConfig => ({
    host: '127.0.0.1',
    port: 9999,
    connectors: [
      {
        alias: 'github',
        secrets: { GITHUB_TOKEN: 'ghp_test', GITHUB_WEBHOOK_SECRET: 'secret123' },
        allowedEndpoints: ['https://api.github.com/**'],
        ingestor: {
          type: 'webhook',
          webhook: {
            path: 'github',
            signatureHeader: 'X-Hub-Signature-256',
            signatureSecret: 'GITHUB_WEBHOOK_SECRET',
          },
        },
      },
    ],
    callers: {
      'test-caller': { connections: ['github'] },
    },
    rateLimitPerMinute: 60,
  });

  it('should pass permanent flag through stopOne to ingestor.stop()', async () => {
    const config = makeWebhookConfig();
    const manager = new IngestorManager(config);
    await manager.startOne('test-caller', 'github');

    // Verify the ingestor is running
    expect(manager.has('test-caller', 'github')).toBe(true);

    // Stop with permanent option
    const result = await manager.stopOne('test-caller', 'github', undefined, { permanent: true });
    const singleResult = result as { success: boolean; state?: string };
    expect(singleResult.success).toBe(true);
    expect(singleResult.state).toBe('stopped');
    expect(manager.has('test-caller', 'github')).toBe(false);
  });

  it('should stop successfully without permanent flag', async () => {
    const config = makeWebhookConfig();
    const manager = new IngestorManager(config);
    await manager.startOne('test-caller', 'github');

    const result = await manager.stopOne('test-caller', 'github');
    const singleResult = result as { success: boolean; state?: string };
    expect(singleResult.success).toBe(true);
    expect(singleResult.state).toBe('stopped');
  });

  it('should pass permanent flag through stopOne with instanceId', async () => {
    const config = makeWebhookConfig();
    const manager = new IngestorManager(config);
    await manager.startOne('test-caller', 'github');

    // Stop a specific instance with permanent flag
    const result = await manager.stopOne('test-caller', 'github', undefined, { permanent: true });
    const singleResult = result as { success: boolean; state?: string };
    expect(singleResult.success).toBe(true);
    expect(manager.has('test-caller', 'github')).toBe(false);
  });

  it('should call stop(true) on stopAll (permanent shutdown)', async () => {
    const config = makeWebhookConfig();
    const manager = new IngestorManager(config);
    await manager.startOne('test-caller', 'github');

    expect(manager.has('test-caller', 'github')).toBe(true);

    // stopAll internally calls stop(true) for permanent shutdown
    await manager.stopAll();

    expect(manager.has('test-caller', 'github')).toBe(false);
  });
});

describe('IngestorManager.applyInstanceParams — instanceKey secrets injection', () => {
  it('should inject instanceKey params into secrets for lifecycle template resolution', () => {
    const config: IngestorConfig = {
      type: 'webhook',
      webhook: { path: 'trello' },
    };
    const secrets: Record<string, string> = { TRELLO_TOKEN: 'tok_test' };
    const params = { boardId: 'board-abc-123' };
    const fields: ListenerConfigField[] = [
      { key: 'boardId', label: 'Board ID', type: 'text', instanceKey: true },
    ];

    IngestorManager.applyInstanceParams(config, secrets, params, fields);

    // Should be attached to webhook config for payload discrimination
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    expect((config.webhook as any)._boardId).toBe('board-abc-123');

    // Should ALSO be injected into secrets for ${boardId} lifecycle template resolution
    expect(secrets.boardId).toBe('board-abc-123');

    // Original secrets should be preserved
    expect(secrets.TRELLO_TOKEN).toBe('tok_test');
  });

  it('should not inject non-string instanceKey params into secrets', () => {
    const config: IngestorConfig = {
      type: 'webhook',
      webhook: { path: 'test' },
    };
    const secrets: Record<string, string> = {};
    const params = { priority: 42 };
    const fields: ListenerConfigField[] = [
      { key: 'priority', label: 'Priority', type: 'number', instanceKey: true },
    ];

    IngestorManager.applyInstanceParams(config, secrets, params, fields);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    expect((config.webhook as any)._priority).toBe(42);

    // Non-string values should NOT be injected into secrets
    expect(secrets.priority).toBeUndefined();
  });
});

describe('IngestorManager — awsSigV4 routes', () => {
  it('should not hand SigV4 signing credentials to a listener', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,

      connectors: [
        {
          alias: 'signed-hook',
          awsSigV4: { service: 'execute-api', region: 'us-east-1' },
          secrets: {
            AWS_ACCESS_KEY_ID: 'AKIDLISTENER',
            AWS_SECRET_ACCESS_KEY: 'listener-secret-key',
            AWS_SESSION_TOKEN: 'listener-session-token',
            WRAPPED: 'pre-listener-secret-key',
            HOOK_SECRET: 'hook-secret',
          },
          allowedEndpoints: ['https://abc.execute-api.us-east-1.amazonaws.com/**'],
          ingestor: {
            type: 'webhook',
            webhook: {
              path: 'signed-hook',
              signatureHeader: 'X-Signature',
              signatureSecret: 'HOOK_SECRET',
            },
          },
        },
      ],
      callers: {
        'test-caller': { connections: ['signed-hook'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.startOne('test-caller', 'signed-hook');
    expect(result.success).toBe(true);

    // Reading private state: the secrets the listener was built with.
    const ingestors = (manager as unknown as { ingestors: Map<string, { secrets: unknown }> })
      .ingestors;
    const [ingestor] = [...ingestors.values()];
    expect(ingestor.secrets).toEqual({ HOOK_SECRET: 'hook-secret' });

    await manager.stopOne('test-caller', 'signed-hook');
  });
});

describe('IngestorManager — header-only secrets', () => {
  it('should still hand header-only and signature secrets to a listener', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      connectors: [
        {
          alias: 'header-hook',
          headers: { Authorization: 'Bearer ${API_TOKEN}' },
          secrets: { API_TOKEN: 'header-only-token', HOOK_SECRET: 'hook-secret' },
          allowedEndpoints: ['https://api.example.com/**'],
          ingestor: {
            type: 'webhook',
            webhook: {
              path: 'header-hook',
              signatureHeader: 'X-Signature',
              signatureSecret: 'HOOK_SECRET',
            },
          },
        },
      ],
      callers: {
        'test-caller': { connections: ['header-hook'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.startOne('test-caller', 'header-hook');
    expect(result.success).toBe(true);

    // Withheld from callers' requests, but listener configs are template-authored.
    const ingestors = (manager as unknown as { ingestors: Map<string, { secrets: unknown }> })
      .ingestors;
    const [ingestor] = [...ingestors.values()];
    expect(ingestor.secrets).toEqual({
      API_TOKEN: 'header-only-token',
      HOOK_SECRET: 'hook-secret',
    });

    await manager.stopOne('test-caller', 'header-hook');
  });
});

describe('IngestorManager — oauth2 poll routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetSharedTokenManager();
  });

  it('gives the poller the route and caller, but not the credentials', async () => {
    const fetchMock = vi.fn((url: string) => {
      const body = url.includes('/token')
        ? { access_token: 'managed-poll-token', expires_in: 3600, scope: 'items.read' }
        : [];
      return Promise.resolve(
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      connectors: [
        {
          alias: 'oauth-poll',
          secrets: { CID: 'client-id-v', CSECRET: 'client-secret-v', RT: 'refresh-v' },
          allowedEndpoints: ['https://api.example.com/**'],
          oauth2: {
            tokenUrl: 'https://auth.example.com/token',
            grant: 'refresh_token',
            clientAuth: 'body',
            secretRefs: { clientId: 'CID', clientSecret: 'CSECRET', refreshToken: 'RT' },
            scopes: ['items.read'],
          },
          ingestor: {
            type: 'poll',
            poll: { url: 'https://api.example.com/items', intervalMs: 60_000 },
          },
        },
      ],
      callers: { alice: { connections: ['oauth-poll'] } },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.startOne('alice', 'oauth-poll');
    expect(result.success).toBe(true);

    const [ingestor] = [
      ...(
        manager as unknown as {
          ingestors: Map<string, { secrets: unknown; oauth2?: { caller: string } }>;
        }
      ).ingestors.values(),
    ];
    // Signer-only: the listener's own secret map has none of them.
    expect(ingestor.secrets).toEqual({});
    expect(ingestor.oauth2?.caller).toBe('alice');

    const apiCall = fetchMock.mock.calls.find(([u]) => u.includes('/items'));
    const headers = (apiCall?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer managed-poll-token');

    await manager.stopOne('alice', 'oauth-poll');
  });
});
