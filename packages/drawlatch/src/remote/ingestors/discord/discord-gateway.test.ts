/**
 * Unit tests for DiscordGatewayIngestor payload filtering.
 *
 * Tests the guild/channel/user ID filtering logic by creating ingestor
 * instances with filter configs and verifying which events get buffered.
 *
 * Note: We can't connect to a real Discord Gateway in unit tests, so we
 * call the internal handleDispatch via a simulated message flow. We create
 * the ingestor, then emit fake Gateway DISPATCH payloads through its
 * WebSocket message handler by reaching into the event processing path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordGatewayIngestor } from './discord-gateway.js';
import type { WebSocketIngestorConfig } from '../types.js';

// Mock WebSocket so we don't actually connect
vi.stubGlobal(
  'WebSocket',
  class MockWebSocket {
    static readonly OPEN = 1;
    readyState = 1;
    addEventListener = vi.fn();
    close = vi.fn();
    send = vi.fn();
  },
);

/**
 * Helper: create an ingestor and simulate dispatch events through it.
 * We access the private handleDispatch method via bracket notation.
 */
function createTestIngestor(
  configOverrides: Partial<WebSocketIngestorConfig> = {},
  bufferSize?: number,
): DiscordGatewayIngestor {
  const config: WebSocketIngestorConfig = {
    gatewayUrl: 'wss://gateway.discord.gg/?v=10&encoding=json',
    protocol: 'discord',
    intents: 4609,
    ...configOverrides,
  };

  return new DiscordGatewayIngestor(
    'test-discord',
    { DISCORD_BOT_TOKEN: 'fake-token' },
    config,
    bufferSize,
  );
}

/** Simulate a Discord Gateway DISPATCH event (op: 0). */
function dispatch(
  ingestor: DiscordGatewayIngestor,
  eventName: string,
  data: unknown,
  seq = 1,
): void {
  // Access private method via bracket notation for testing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ingestor as any).handleDispatch({
    op: 0,
    d: data,
    s: seq,
    t: eventName,
  });
}

describe('DiscordGatewayIngestor — payload filtering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Guild ID filtering ──────────────────────────────────────────────

  describe('guildIds filter', () => {
    it('should buffer events matching the guild filter', () => {
      const ingestor = createTestIngestor({ guildIds: ['guild-1'] });
      dispatch(ingestor, 'MESSAGE_CREATE', {
        guild_id: 'guild-1',
        channel_id: 'ch-1',
        content: 'hello',
        author: { id: 'user-1' },
      });

      const events = ingestor.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('MESSAGE_CREATE');
    });

    it('should drop events not matching the guild filter', () => {
      const ingestor = createTestIngestor({ guildIds: ['guild-1'] });
      dispatch(ingestor, 'MESSAGE_CREATE', {
        guild_id: 'guild-other',
        channel_id: 'ch-1',
        content: 'hello',
        author: { id: 'user-1' },
      });

      expect(ingestor.getEvents()).toHaveLength(0);
    });

    it('should pass through events without guild_id field (e.g., READY)', () => {
      const ingestor = createTestIngestor({ guildIds: ['guild-1'] });
      dispatch(ingestor, 'READY', {
        session_id: 'sess-1',
        resume_gateway_url: 'wss://resume.example.com',
      });

      const events = ingestor.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('READY');
    });

    it('should accept multiple guild IDs', () => {
      const ingestor = createTestIngestor({ guildIds: ['guild-1', 'guild-2'] });

      dispatch(ingestor, 'MESSAGE_CREATE', { guild_id: 'guild-1', author: { id: 'u1' } }, 1);
      dispatch(ingestor, 'MESSAGE_CREATE', { guild_id: 'guild-2', author: { id: 'u2' } }, 2);
      dispatch(ingestor, 'MESSAGE_CREATE', { guild_id: 'guild-3', author: { id: 'u3' } }, 3);

      expect(ingestor.getEvents()).toHaveLength(2);
    });
  });

  // ── Channel ID filtering ────────────────────────────────────────────

  describe('channelIds filter', () => {
    it('should buffer events matching the channel filter', () => {
      const ingestor = createTestIngestor({ channelIds: ['ch-1'] });
      dispatch(ingestor, 'MESSAGE_CREATE', {
        guild_id: 'guild-1',
        channel_id: 'ch-1',
        content: 'hello',
        author: { id: 'user-1' },
      });

      expect(ingestor.getEvents()).toHaveLength(1);
    });

    it('should drop events not matching the channel filter', () => {
      const ingestor = createTestIngestor({ channelIds: ['ch-1'] });
      dispatch(ingestor, 'MESSAGE_CREATE', {
        guild_id: 'guild-1',
        channel_id: 'ch-other',
        content: 'hello',
        author: { id: 'user-1' },
      });

      expect(ingestor.getEvents()).toHaveLength(0);
    });

    it('should pass through events without channel_id field', () => {
      const ingestor = createTestIngestor({ channelIds: ['ch-1'] });
      dispatch(ingestor, 'GUILD_MEMBER_ADD', {
        guild_id: 'guild-1',
        user: { id: 'user-1' },
      });

      expect(ingestor.getEvents()).toHaveLength(1);
    });
  });

  // ── User ID filtering ───────────────────────────────────────────────

  describe('userIds filter', () => {
    it('should buffer events matching author.id', () => {
      const ingestor = createTestIngestor({ userIds: ['user-1'] });
      dispatch(ingestor, 'MESSAGE_CREATE', {
        guild_id: 'guild-1',
        channel_id: 'ch-1',
        author: { id: 'user-1' },
      });

      expect(ingestor.getEvents()).toHaveLength(1);
    });

    it('should buffer events matching user.id', () => {
      const ingestor = createTestIngestor({ userIds: ['user-1'] });
      dispatch(ingestor, 'GUILD_MEMBER_ADD', {
        guild_id: 'guild-1',
        user: { id: 'user-1' },
      });

      expect(ingestor.getEvents()).toHaveLength(1);
    });

    it('should buffer events matching user_id', () => {
      const ingestor = createTestIngestor({ userIds: ['user-1'] });
      dispatch(ingestor, 'TYPING_START', {
        guild_id: 'guild-1',
        channel_id: 'ch-1',
        user_id: 'user-1',
      });

      expect(ingestor.getEvents()).toHaveLength(1);
    });

    it('should drop events with non-matching user', () => {
      const ingestor = createTestIngestor({ userIds: ['user-1'] });
      dispatch(ingestor, 'MESSAGE_CREATE', {
        guild_id: 'guild-1',
        channel_id: 'ch-1',
        author: { id: 'user-other' },
      });

      expect(ingestor.getEvents()).toHaveLength(0);
    });

    it('should pass through events without any user identifier', () => {
      const ingestor = createTestIngestor({ userIds: ['user-1'] });
      dispatch(ingestor, 'CHANNEL_CREATE', {
        guild_id: 'guild-1',
        id: 'ch-new',
        type: 0,
      });

      expect(ingestor.getEvents()).toHaveLength(1);
    });
  });

  // ── Combined filters (AND logic) ───────────────────────────────────

  describe('combined filters', () => {
    it('should require all filters to match (AND logic)', () => {
      const ingestor = createTestIngestor({
        guildIds: ['guild-1'],
        channelIds: ['ch-1'],
        userIds: ['user-1'],
      });

      // All match → buffered
      dispatch(
        ingestor,
        'MESSAGE_CREATE',
        { guild_id: 'guild-1', channel_id: 'ch-1', author: { id: 'user-1' } },
        1,
      );

      // Wrong guild → dropped
      dispatch(
        ingestor,
        'MESSAGE_CREATE',
        { guild_id: 'guild-2', channel_id: 'ch-1', author: { id: 'user-1' } },
        2,
      );

      // Wrong channel → dropped
      dispatch(
        ingestor,
        'MESSAGE_CREATE',
        { guild_id: 'guild-1', channel_id: 'ch-2', author: { id: 'user-1' } },
        3,
      );

      // Wrong user → dropped
      dispatch(
        ingestor,
        'MESSAGE_CREATE',
        { guild_id: 'guild-1', channel_id: 'ch-1', author: { id: 'user-2' } },
        4,
      );

      expect(ingestor.getEvents()).toHaveLength(1);
    });

    it('should combine guildIds with eventFilter', () => {
      const ingestor = createTestIngestor({
        guildIds: ['guild-1'],
        eventFilter: ['MESSAGE_CREATE'],
      });

      // Matching guild + matching event → buffered
      dispatch(ingestor, 'MESSAGE_CREATE', { guild_id: 'guild-1', author: { id: 'u1' } }, 1);

      // Matching guild + wrong event → dropped by eventFilter
      dispatch(ingestor, 'MESSAGE_DELETE', { guild_id: 'guild-1' }, 2);

      // Wrong guild + matching event → dropped by guildIds
      dispatch(ingestor, 'MESSAGE_CREATE', { guild_id: 'guild-2', author: { id: 'u2' } }, 3);

      expect(ingestor.getEvents()).toHaveLength(1);
    });
  });

  // ── No filters (default behavior) ──────────────────────────────────

  describe('no filters', () => {
    it('should buffer all events when no filters are set', () => {
      const ingestor = createTestIngestor({});

      dispatch(ingestor, 'MESSAGE_CREATE', { guild_id: 'g1', author: { id: 'u1' } }, 1);
      dispatch(ingestor, 'TYPING_START', { guild_id: 'g2', user_id: 'u2' }, 2);
      dispatch(ingestor, 'GUILD_CREATE', { id: 'g3' }, 3);

      expect(ingestor.getEvents()).toHaveLength(3);
    });
  });

  // ── Buffer size override ────────────────────────────────────────────

  describe('bufferSize', () => {
    it('should respect custom buffer size', () => {
      const ingestor = createTestIngestor({}, 3);

      for (let i = 0; i < 5; i++) {
        dispatch(ingestor, 'MESSAGE_CREATE', { guild_id: 'g1', author: { id: 'u1' } }, i + 1);
      }

      // Buffer capacity is 3, so only last 3 events remain
      const events = ingestor.getEvents();
      expect(events).toHaveLength(3);
      // IDs are epoch-based, so verify relative ordering instead of exact values
      expect(events[0].id).toBeLessThan(events[1].id);
      expect(events[1].id).toBeLessThan(events[2].id);
    });
  });

  // ── Idempotency / deduplication ────────────────────────────────────

  describe('idempotency keys', () => {
    it('should include session ID in idempotency key after READY', () => {
      const ingestor = createTestIngestor({});

      // Simulate a READY event to set the session ID
      dispatch(
        ingestor,
        'READY',
        { session_id: 'sess_abc', resume_gateway_url: 'wss://resume.discord.gg' },
        1,
      );

      // Now send a real event — key should include the session ID
      dispatch(ingestor, 'MESSAGE_CREATE', { guild_id: 'g1', author: { id: 'u1' } }, 42);

      const events = ingestor.getEvents();
      expect(events).toHaveLength(2); // READY + MESSAGE_CREATE
      expect(events[1].idempotencyKey).toBe('discord:test-discord:sess_abc:seq:42');
    });

    it('should use nosess fallback in idempotency key before READY', () => {
      const ingestor = createTestIngestor({});
      dispatch(ingestor, 'MESSAGE_CREATE', { guild_id: 'g1', author: { id: 'u1' } }, 42);

      const events = ingestor.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].idempotencyKey).toBe('discord:test-discord:nosess:seq:42');
    });

    it('should deduplicate replayed events with the same sequence number', () => {
      const ingestor = createTestIngestor({});
      const messageData = {
        guild_id: 'g1',
        channel_id: 'ch-1',
        author: { id: 'u1' },
        content: 'hello',
      };

      dispatch(ingestor, 'MESSAGE_CREATE', messageData, 42);
      dispatch(ingestor, 'MESSAGE_CREATE', messageData, 42); // replay

      expect(ingestor.getEvents()).toHaveLength(1);
    });

    it('should not deduplicate events with different sequence numbers', () => {
      const ingestor = createTestIngestor({});

      dispatch(ingestor, 'MESSAGE_CREATE', { guild_id: 'g1', author: { id: 'u1' } }, 1);
      dispatch(ingestor, 'MESSAGE_CREATE', { guild_id: 'g1', author: { id: 'u1' } }, 2);

      expect(ingestor.getEvents()).toHaveLength(2);
    });
  });
});
