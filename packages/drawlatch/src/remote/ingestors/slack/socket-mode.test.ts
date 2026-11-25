/**
 * Unit tests for SlackSocketModeIngestor.
 *
 * Tests the Socket Mode lifecycle, envelope acknowledgment, event filtering,
 * disconnect handling, and reconnection logic.
 *
 * We mock both WebSocket and fetch to avoid real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackSocketModeIngestor } from './socket-mode.js';
import type { WebSocketIngestorConfig } from '../types.js';
import type { SlackEnvelope } from './types.js';

// ── Mock WebSocket ──────────────────────────────────────────────────────

type MessageHandler = (event: { data: string }) => void;
type CloseHandler = (event: { code: number; reason: string }) => void;
type Handler = (...args: unknown[]) => void;

class MockWebSocket {
  static readonly OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();

  private handlers = new Map<string, Handler>();

  addEventListener(event: string, handler: Handler): void {
    this.handlers.set(event, handler);
  }

  removeEventListener(event: string, _handler: Handler): void {
    this.handlers.delete(event);
  }

  /** Simulate receiving a message from Slack. */
  simulateMessage(data: SlackEnvelope | Record<string, unknown>): void {
    const handler = this.handlers.get('message') as MessageHandler | undefined;
    handler?.({ data: JSON.stringify(data) });
  }

  /** Simulate the WebSocket closing. */
  simulateClose(code = 1000, reason = ''): void {
    const handler = this.handlers.get('close') as CloseHandler | undefined;
    handler?.({ code, reason });
  }

  /** Simulate the 'open' event. */
  simulateOpen(): void {
    const handler = this.handlers.get('open');
    handler?.();
  }
}

let latestMockWs: MockWebSocket | null = null;

vi.stubGlobal(
  'WebSocket',
  class extends MockWebSocket {
    constructor() {
      super();
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      latestMockWs = this;
    }
  },
);

// ── Mock fetch ──────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockConnectionsOpen(url = 'wss://wss.slack.com/link/?ticket=test-123'): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ok: true, url }),
  });
}

function mockConnectionsOpenError(error = 'invalid_auth'): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ok: false, error }),
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────

function createTestIngestor(
  configOverrides: Partial<WebSocketIngestorConfig> = {},
  bufferSize?: number,
): SlackSocketModeIngestor {
  const config: WebSocketIngestorConfig = {
    gatewayUrl: 'https://slack.com/api/apps.connections.open',
    protocol: 'slack',
    ...configOverrides,
  };

  return new SlackSocketModeIngestor(
    'test-slack',
    { SLACK_APP_TOKEN: 'xapp-test-token', SLACK_BOT_TOKEN: 'xoxb-test-token' },
    config,
    bufferSize,
  );
}

function helloMessage(overrides: Record<string, unknown> = {}): SlackEnvelope {
  return {
    type: 'hello',
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function eventsApiEnvelope(
  eventType: string,
  eventData: Record<string, unknown> = {},
  envelopeId = 'env-1',
): SlackEnvelope {
  return {
    type: 'events_api',
    envelope_id: envelopeId,
    payload: {
      event: {
        type: eventType,
        ...eventData,
      },
    },
    accepts_response_payload: false,
  };
}

function slashCommandEnvelope(
  command: string,
  data: Record<string, unknown> = {},
  envelopeId = 'env-cmd-1',
): SlackEnvelope {
  return {
    type: 'slash_commands',
    envelope_id: envelopeId,
    payload: { command, ...data },
    accepts_response_payload: true,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('SlackSocketModeIngestor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latestMockWs = null;
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Connection lifecycle ──────────────────────────────────────────

  describe('connection lifecycle', () => {
    it('should call apps.connections.open and connect WebSocket on start', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://slack.com/api/apps.connections.open',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer xapp-test-token',
          }) as Record<string, string>,
        }),
      );
      expect(latestMockWs).not.toBeNull();
    });

    it('should set state to connected on hello message', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      latestMockWs!.simulateMessage({
        type: 'hello',
        connection_info: { app_id: 'A1234' },
        num_connections: 1,
        debug_info: {
          host: 'wss-test',
          started: '2026-01-01',
          build_number: 1,
          approximate_connection_time: 3600,
        },
      });

      expect(ingestor.getStatus().state).toBe('connected');
    });

    it('should set state to error if SLACK_APP_TOKEN is missing', async () => {
      const ingestor = new SlackSocketModeIngestor(
        'test-slack',
        { SLACK_BOT_TOKEN: 'xoxb-test' }, // no SLACK_APP_TOKEN
        { gatewayUrl: 'https://slack.com/api/apps.connections.open', protocol: 'slack' },
      );

      await ingestor.start();
      expect(ingestor.getStatus().state).toBe('error');
      expect(ingestor.getStatus().error).toContain('SLACK_APP_TOKEN');
    });

    it('should set state to error if apps.connections.open fails', async () => {
      mockConnectionsOpenError('invalid_auth');
      const ingestor = createTestIngestor();
      await ingestor.start();

      expect(ingestor.getStatus().state).toBe('error');
      expect(ingestor.getStatus().error).toContain('invalid_auth');
    });

    it('should report a cross-origin redirect as not followed', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
      );
      const ingestor = createTestIngestor();
      await ingestor.start();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(ingestor.getStatus().state).toBe('error');
      expect(ingestor.getStatus().error).toContain('redirect not followed');
    });

    it('should close WebSocket on stop', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      const stopPromise = ingestor.stop();
      // stop() waits for the WebSocket 'close' event — simulate it so the promise resolves
      latestMockWs!.simulateClose(1000, 'Shutting down');
      await stopPromise;

      expect(latestMockWs!.close).toHaveBeenCalledWith(1000, 'Shutting down');
      expect(ingestor.getStatus().state).toBe('stopped');
    });
  });

  // ── Envelope acknowledgment ───────────────────────────────────────

  describe('envelope acknowledgment', () => {
    it('should acknowledge events_api envelopes', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      latestMockWs!.simulateMessage(
        eventsApiEnvelope('message', { channel: 'C123', user: 'U456', text: 'hello' }, 'ack-1'),
      );

      expect(latestMockWs!.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'ack-1' }));
    });

    it('should acknowledge slash_commands envelopes', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      latestMockWs!.simulateMessage(
        slashCommandEnvelope('/test', { channel_id: 'C123', user_id: 'U456' }, 'ack-cmd-1'),
      );

      expect(latestMockWs!.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'ack-cmd-1' }));
    });

    it('should acknowledge unknown message types that have an envelope_id', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      latestMockWs!.simulateMessage({
        type: 'options' as SlackEnvelope['type'],
        envelope_id: 'ack-opt-1',
        payload: {},
      });

      expect(latestMockWs!.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'ack-opt-1' }));
    });
  });

  // ── Event buffering ───────────────────────────────────────────────

  describe('event buffering', () => {
    it('should buffer events_api envelopes', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      latestMockWs!.simulateMessage(
        eventsApiEnvelope('message', { channel: 'C123', user: 'U456', text: 'hello' }),
      );

      const events = ingestor.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('message');
      expect(events[0].source).toBe('test-slack');
    });

    it('should buffer slash_commands with command name as event type', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      latestMockWs!.simulateMessage(slashCommandEnvelope('/deploy', { channel_id: 'C123' }));

      const events = ingestor.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('/deploy');
    });

    it('should buffer interactive messages with interaction type', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      latestMockWs!.simulateMessage({
        type: 'interactive',
        envelope_id: 'env-int-1',
        payload: { type: 'block_actions', channel: { id: 'C123' }, user: { id: 'U456' } },
        accepts_response_payload: true,
      });

      const events = ingestor.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('block_actions');
    });

    it('should not buffer hello or disconnect messages', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      latestMockWs!.simulateMessage(
        helloMessage({
          connection_info: { app_id: 'A1234' },
          num_connections: 1,
          debug_info: {
            host: 'wss-test',
            started: '2026-01-01',
            build_number: 1,
            approximate_connection_time: 3600,
          },
        }),
      );

      expect(ingestor.getEvents()).toHaveLength(0);
    });

    it('should respect custom buffer size', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor({}, 3);
      await ingestor.start();

      for (let i = 0; i < 5; i++) {
        latestMockWs!.simulateMessage(
          eventsApiEnvelope('message', { channel: 'C123', text: `msg-${i}` }, `env-${i}`),
        );
      }

      const events = ingestor.getEvents();
      expect(events).toHaveLength(3);
      // IDs are epoch-based, so verify relative ordering instead of exact values
      expect(events[0].id).toBeLessThan(events[1].id);
      expect(events[1].id).toBeLessThan(events[2].id);
    });
  });

  // ── Event filtering ───────────────────────────────────────────────

  describe('event filtering', () => {
    it('should filter by event type', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor({ eventFilter: ['message'] });
      await ingestor.start();

      latestMockWs!.simulateMessage(
        eventsApiEnvelope('message', { channel: 'C123', text: 'hello' }, 'env-1'),
      );
      latestMockWs!.simulateMessage(
        eventsApiEnvelope('reaction_added', { channel: 'C123', reaction: 'thumbsup' }, 'env-2'),
      );

      expect(ingestor.getEvents()).toHaveLength(1);
      expect(ingestor.getEvents()[0].eventType).toBe('message');
    });

    it('should filter by channel ID', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor({ channelIds: ['C111'] });
      await ingestor.start();

      latestMockWs!.simulateMessage(
        eventsApiEnvelope('message', { channel: 'C111', user: 'U1', text: 'match' }, 'env-1'),
      );
      latestMockWs!.simulateMessage(
        eventsApiEnvelope('message', { channel: 'C222', user: 'U2', text: 'no match' }, 'env-2'),
      );

      expect(ingestor.getEvents()).toHaveLength(1);
    });

    it('should filter by user ID', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor({ userIds: ['U111'] });
      await ingestor.start();

      latestMockWs!.simulateMessage(
        eventsApiEnvelope('message', { channel: 'C1', user: 'U111', text: 'match' }, 'env-1'),
      );
      latestMockWs!.simulateMessage(
        eventsApiEnvelope('message', { channel: 'C1', user: 'U222', text: 'no match' }, 'env-2'),
      );

      expect(ingestor.getEvents()).toHaveLength(1);
    });

    it('should pass through events without the filtered field', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor({ channelIds: ['C111'] });
      await ingestor.start();

      // Event with no channel field should pass through
      latestMockWs!.simulateMessage(eventsApiEnvelope('app_mention', {}, 'env-1'));

      expect(ingestor.getEvents()).toHaveLength(1);
    });

    it('should use channel_id for slash commands', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor({ channelIds: ['C111'] });
      await ingestor.start();

      latestMockWs!.simulateMessage(
        slashCommandEnvelope('/deploy', { channel_id: 'C111' }, 'env-1'),
      );
      latestMockWs!.simulateMessage(
        slashCommandEnvelope('/deploy', { channel_id: 'C222' }, 'env-2'),
      );

      expect(ingestor.getEvents()).toHaveLength(1);
    });

    it('should use user_id for slash commands', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor({ userIds: ['U111'] });
      await ingestor.start();

      latestMockWs!.simulateMessage(
        slashCommandEnvelope('/deploy', { user_id: 'U111', channel_id: 'C1' }, 'env-1'),
      );
      latestMockWs!.simulateMessage(
        slashCommandEnvelope('/deploy', { user_id: 'U222', channel_id: 'C1' }, 'env-2'),
      );

      expect(ingestor.getEvents()).toHaveLength(1);
    });

    it('should combine filters with AND logic', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor({ channelIds: ['C111'], userIds: ['U111'] });
      await ingestor.start();

      // Both match
      latestMockWs!.simulateMessage(
        eventsApiEnvelope('message', { channel: 'C111', user: 'U111' }, 'env-1'),
      );
      // Channel matches, user doesn't
      latestMockWs!.simulateMessage(
        eventsApiEnvelope('message', { channel: 'C111', user: 'U222' }, 'env-2'),
      );
      // User matches, channel doesn't
      latestMockWs!.simulateMessage(
        eventsApiEnvelope('message', { channel: 'C222', user: 'U111' }, 'env-3'),
      );

      expect(ingestor.getEvents()).toHaveLength(1);
    });

    it('should buffer all events when no filters are set', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      latestMockWs!.simulateMessage(
        eventsApiEnvelope('message', { channel: 'C1', user: 'U1' }, 'env-1'),
      );
      latestMockWs!.simulateMessage(
        eventsApiEnvelope('reaction_added', { channel: 'C2' }, 'env-2'),
      );
      latestMockWs!.simulateMessage(slashCommandEnvelope('/test', { channel_id: 'C3' }, 'env-3'));

      expect(ingestor.getEvents()).toHaveLength(3);
    });
  });

  // ── Disconnect handling ───────────────────────────────────────────

  describe('disconnect handling', () => {
    it('should reconnect on refresh_requested', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      // Set up next connection
      mockConnectionsOpen('wss://wss.slack.com/link/?ticket=refresh-123');

      latestMockWs!.simulateMessage({
        type: 'disconnect',
        reason: 'refresh_requested',
        debug_info: { host: 'wss-old' },
      });

      expect(ingestor.getStatus().state).toBe('reconnecting');

      // Advance past backoff timer (attempts reset for Slack-initiated reconnects)
      await vi.advanceTimersByTimeAsync(3000);

      // Should have called apps.connections.open again
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should reconnect on warning', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      mockConnectionsOpen('wss://wss.slack.com/link/?ticket=warning-123');

      latestMockWs!.simulateMessage({
        type: 'disconnect',
        reason: 'warning',
        debug_info: { host: 'wss-old' },
      });

      expect(ingestor.getStatus().state).toBe('reconnecting');
    });

    it('should set error state on link_disabled', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      latestMockWs!.simulateMessage({
        type: 'disconnect',
        reason: 'link_disabled',
        debug_info: { host: 'wss-old' },
      });

      expect(ingestor.getStatus().state).toBe('error');
      expect(ingestor.getStatus().error).toContain('link_disabled');
    });
  });

  // ── WebSocket close reconnection ──────────────────────────────────

  describe('reconnection on WebSocket close', () => {
    it('should reconnect with exponential backoff on unexpected close', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      mockConnectionsOpen();
      latestMockWs!.simulateClose(1006, 'Abnormal closure');

      expect(ingestor.getStatus().state).toBe('reconnecting');

      // First backoff: 2s (1000 * 2^1)
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should not reconnect after stop', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      const stopPromise = ingestor.stop();
      // stop() waits for the WebSocket 'close' event — simulate it so the promise resolves
      latestMockWs!.simulateClose(1000, 'Shutting down');
      await stopPromise;

      // Should remain stopped, not reconnecting
      expect(ingestor.getStatus().state).toBe('stopped');
    });

    it('should error after max reconnect attempts', async () => {
      mockConnectionsOpen();
      const ingestor = createTestIngestor();
      await ingestor.start();

      // Each cycle: close triggers scheduleReconnect (increments counter),
      // timer fires → openConnection → new WS connects → close again.
      // After 10 increments, the next close triggers the "exceeded" check.
      for (let i = 0; i < 10; i++) {
        mockConnectionsOpen();
        latestMockWs!.simulateClose(1006, 'Connection lost');
        const backoff = Math.min(1000 * Math.pow(2, i + 1), 30_000);
        await vi.advanceTimersByTimeAsync(backoff);
      }

      // 10 attempts used up — one more close triggers the max check
      latestMockWs!.simulateClose(1006, 'Connection lost');

      expect(ingestor.getStatus().state).toBe('error');
      expect(ingestor.getStatus().error).toContain('Max reconnect attempts');
    });
  });
});
