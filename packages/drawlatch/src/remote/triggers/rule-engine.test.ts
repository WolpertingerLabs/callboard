/**
 * Unit tests for the TriggerRuleEngine.
 *
 * Tests cover:
 * - Rule matching: source, event type, instance ID, dot-path filters
 * - Throttle enforcement: rate limiting and deduplication
 * - Dispatch: successful invocation and error handling
 * - Disabled rules
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TriggerRuleEngine } from './rule-engine.js';
import type { TriggerRule } from './types.js';
import type { IngestedEvent } from '../ingestors/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<IngestedEvent> = {}): IngestedEvent {
  return {
    id: 1,
    idempotencyKey: 'test:1',
    receivedAt: new Date().toISOString(),
    receivedAtMs: Date.now(),
    callerAlias: 'default',
    source: 'github',
    eventType: 'pull_request',
    data: {
      deliveryId: 'del-123',
      event: 'pull_request',
      payload: {
        action: 'opened',
        pull_request: { number: 42, title: 'Add feature' },
      },
    },
    ...overrides,
  };
}

function makeRule(overrides: Partial<TriggerRule> = {}): TriggerRule {
  return {
    name: 'test-rule',
    source: 'github',
    target: { type: 'remote_trigger', triggerId: 'trg_abc123' },
    ...overrides,
  };
}

function mockFetchResponse(status = 200, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const TEST_SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-test-key',
};

// ── Tests ───────────────────────────────────────────────────────────────

describe('TriggerRuleEngine', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(200));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rule matching ─────────────────────────────────────────────────────

  describe('rule matching', () => {
    it('should match events by source', async () => {
      const engine = new TriggerRuleEngine([makeRule({ source: 'github' })], TEST_SECRETS);
      engine.handleEvent(makeEvent({ source: 'github' }));

      // Allow async dispatch to complete
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    });

    it('should not match events from a different source', async () => {
      const engine = new TriggerRuleEngine([makeRule({ source: 'discord-bot' })], TEST_SECRETS);
      engine.handleEvent(makeEvent({ source: 'github' }));

      // Give time for any potential async dispatch
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should filter by event type', async () => {
      const engine = new TriggerRuleEngine(
        [makeRule({ eventTypes: ['push', 'pull_request'] })],
        TEST_SECRETS,
      );

      engine.handleEvent(makeEvent({ eventType: 'pull_request' }));
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

      // Reset
      fetchSpy.mockClear();

      engine.handleEvent(makeEvent({ eventType: 'issues' }));
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should match all event types when eventTypes is empty', async () => {
      const engine = new TriggerRuleEngine([makeRule({ eventTypes: [] })], TEST_SECRETS);
      engine.handleEvent(makeEvent({ eventType: 'anything' }));
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    });

    it('should filter by instance ID', async () => {
      const engine = new TriggerRuleEngine([makeRule({ instanceId: 'repo-a' })], TEST_SECRETS);

      engine.handleEvent(makeEvent({ instanceId: 'repo-a' }));
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

      fetchSpy.mockClear();

      engine.handleEvent(makeEvent({ instanceId: 'repo-b' }));
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should apply dot-path filter predicates', async () => {
      const engine = new TriggerRuleEngine(
        [
          makeRule({
            filter: { 'payload.action': ['opened', 'synchronize'] },
          }),
        ],
        TEST_SECRETS,
      );

      // Matching action
      engine.handleEvent(makeEvent());
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

      fetchSpy.mockClear();

      // Non-matching action
      engine.handleEvent(
        makeEvent({
          data: {
            deliveryId: 'del-456',
            event: 'pull_request',
            payload: { action: 'closed', pull_request: { number: 42 } },
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should require all filter predicates to match (AND logic)', async () => {
      const engine = new TriggerRuleEngine(
        [
          makeRule({
            filter: {
              'payload.action': ['opened'],
              'payload.pull_request.number': [99],
            },
          }),
        ],
        TEST_SECRETS,
      );

      // Only action matches, not PR number
      engine.handleEvent(makeEvent());
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── Disabled rules ──────────────────────────────────────────────────

  describe('disabled rules', () => {
    it('should skip disabled rules', async () => {
      const engine = new TriggerRuleEngine([makeRule({ enabled: false })], TEST_SECRETS);

      expect(engine.activeRuleCount).toBe(0);
      engine.handleEvent(makeEvent());
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── Throttle ──────────────────────────────────────────────────────────

  describe('throttle', () => {
    it('should enforce maxPerMinute rate limit', async () => {
      const engine = new TriggerRuleEngine(
        [makeRule({ throttle: { maxPerMinute: 2 } })],
        TEST_SECRETS,
      );

      // First two should dispatch
      engine.handleEvent(makeEvent({ id: 1 }));
      engine.handleEvent(makeEvent({ id: 2 }));
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

      // Third should be throttled
      engine.handleEvent(makeEvent({ id: 3 }));
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should deduplicate by configured field', async () => {
      const engine = new TriggerRuleEngine(
        [
          makeRule({
            throttle: { maxPerMinute: 10, deduplicateBy: 'payload.pull_request.number' },
          }),
        ],
        TEST_SECRETS,
      );

      // First dispatch for PR #42
      engine.handleEvent(makeEvent());
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

      // Same PR #42 — should be deduped
      engine.handleEvent(makeEvent({ id: 2 }));
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Dispatch ──────────────────────────────────────────────────────────

  describe('dispatch', () => {
    it('should POST to the remote trigger API with event data', async () => {
      const engine = new TriggerRuleEngine(
        [makeRule({ target: { type: 'remote_trigger', triggerId: 'trg_xyz' } })],
        TEST_SECRETS,
      );

      engine.handleEvent(makeEvent());
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

      const call = fetchSpy.mock.calls[0];
      expect(call[0]).toBe('https://api.anthropic.com/v1/code/triggers/trg_xyz/run');
      expect(call[1].method).toBe('POST');

      const headers = call[1].headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-ant-test-key');
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(call[1].body as string) as {
        event: { source: string; eventType: string; data: unknown };
      };
      expect(body.event.source).toBe('github');
      expect(body.event.eventType).toBe('pull_request');
    });

    it('should log error when ANTHROPIC_API_KEY is missing', async () => {
      const engine = new TriggerRuleEngine([makeRule()], {});
      engine.handleEvent(makeEvent());

      await new Promise((r) => setTimeout(r, 50));
      expect(fetchSpy).not.toHaveBeenCalled();

      const log = engine.getDispatchLog();
      expect(log).toHaveLength(1);
      expect(log[0].success).toBe(false);
      expect(log[0].error).toContain('ANTHROPIC_API_KEY');
    });

    it('should handle HTTP errors gracefully', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(500, { error: 'Internal error' }));

      const engine = new TriggerRuleEngine([makeRule()], TEST_SECRETS);
      engine.handleEvent(makeEvent());

      await vi.waitFor(() => {
        const log = engine.getDispatchLog();
        expect(log).toHaveLength(1);
      });

      const log = engine.getDispatchLog();
      expect(log[0].success).toBe(false);
      expect(log[0].statusCode).toBe(500);
    });

    it('should handle network errors gracefully', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));

      const engine = new TriggerRuleEngine([makeRule()], TEST_SECRETS);
      engine.handleEvent(makeEvent());

      await vi.waitFor(() => {
        const log = engine.getDispatchLog();
        expect(log).toHaveLength(1);
      });

      const log = engine.getDispatchLog();
      expect(log[0].success).toBe(false);
      expect(log[0].error).toContain('Network error');
    });

    it('should record successful dispatches in the log', async () => {
      const engine = new TriggerRuleEngine([makeRule()], TEST_SECRETS);
      engine.handleEvent(makeEvent());

      await vi.waitFor(() => {
        const log = engine.getDispatchLog();
        expect(log).toHaveLength(1);
      });

      const log = engine.getDispatchLog();
      expect(log[0].success).toBe(true);
      expect(log[0].triggerId).toBe('trg_abc123');
      expect(log[0].rule).toBe('test-rule');
      expect(log[0].dispatchedAt).toBeDefined();
    });
  });
});
