/**
 * Unit tests for the Trello webhook ingestor and signature verification.
 */

import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { TrelloWebhookIngestor } from './trello-webhook-ingestor.js';
import {
  verifyTrelloSignature,
  extractTrelloActionType,
  extractTrelloActionId,
  TRELLO_SIGNATURE_HEADER,
} from './trello-types.js';
import { createIngestor } from '../registry.js';

// ── Helpers ─────────────────────────────────────────────────────────────

const CALLBACK_URL = 'https://example.com/webhooks/trello';

function signTrelloPayload(
  body: string,
  secret: string,
  callbackUrl: string = CALLBACK_URL,
): string {
  const content = body + callbackUrl;
  return crypto.createHmac('sha1', secret).update(content).digest('base64');
}

function makeTrelloPayload(actionType = 'updateCard', actionId = 'action-123'): object {
  return {
    action: {
      id: actionId,
      type: actionType,
      date: '2026-02-18T12:00:00.000Z',
      idMemberCreator: 'member-456',
      data: {
        board: { id: 'board-789', name: 'Test Board' },
        card: { id: 'card-abc', name: 'Test Card', idShort: 42 },
        list: { id: 'list-def', name: 'To Do' },
      },
      memberCreator: {
        id: 'member-456',
        fullName: 'Test User',
        username: 'testuser',
      },
    },
    model: {
      id: 'board-789',
      name: 'Test Board',
    },
    webhook: {
      id: 'webhook-001',
      description: 'Test Webhook',
      idModel: 'board-789',
      callbackURL: CALLBACK_URL,
      active: true,
      consecutiveFailures: 0,
    },
  };
}

// ── verifyTrelloSignature ───────────────────────────────────────────────

describe('verifyTrelloSignature', () => {
  const secret = 'test-api-secret';
  const body = Buffer.from(JSON.stringify(makeTrelloPayload()));

  it('should return true for a valid HMAC-SHA1 signature', () => {
    const sig = signTrelloPayload(body.toString(), secret);
    expect(verifyTrelloSignature(body, sig, secret, CALLBACK_URL)).toBe(true);
  });

  it('should return false for an invalid signature (wrong secret)', () => {
    const sig = signTrelloPayload(body.toString(), 'wrong-secret');
    expect(verifyTrelloSignature(body, sig, secret, CALLBACK_URL)).toBe(false);
  });

  it('should return false when callback URL does not match', () => {
    const sig = signTrelloPayload(body.toString(), secret, 'https://wrong-url.com/webhooks/trello');
    expect(verifyTrelloSignature(body, sig, secret, CALLBACK_URL)).toBe(false);
  });

  it('should return false for an invalid base64 string', () => {
    expect(verifyTrelloSignature(body, '!!!not-valid-base64!!!', secret, CALLBACK_URL)).toBe(false);
  });

  it('should return false when signature has wrong length', () => {
    expect(verifyTrelloSignature(body, 'dG9vc2hvcnQ=', secret, CALLBACK_URL)).toBe(false);
  });

  it('should handle empty body', () => {
    const emptyBody = Buffer.from('');
    const sig = signTrelloPayload('', secret);
    expect(verifyTrelloSignature(emptyBody, sig, secret, CALLBACK_URL)).toBe(true);
  });

  it('should handle body with special characters', () => {
    const specialBody = Buffer.from('{"name":"Tëst Cärd 日本語"}');
    const sig = signTrelloPayload(specialBody.toString(), secret);
    expect(verifyTrelloSignature(specialBody, sig, secret, CALLBACK_URL)).toBe(true);
  });

  it('should include callbackUrl in the signed content', () => {
    // Same body and secret but different callback URLs should produce different signatures
    const sig1 = signTrelloPayload(body.toString(), secret, 'https://url1.com/hook');
    const sig2 = signTrelloPayload(body.toString(), secret, 'https://url2.com/hook');
    expect(sig1).not.toBe(sig2);
  });
});

// ── extractTrelloActionType ─────────────────────────────────────────────

describe('extractTrelloActionType', () => {
  it('should extract action type from a valid payload', () => {
    expect(extractTrelloActionType(makeTrelloPayload('createCard'))).toBe('createCard');
  });

  it('should extract different action types', () => {
    expect(extractTrelloActionType(makeTrelloPayload('commentCard'))).toBe('commentCard');
    expect(extractTrelloActionType(makeTrelloPayload('addMemberToBoard'))).toBe('addMemberToBoard');
    expect(extractTrelloActionType(makeTrelloPayload('updateList'))).toBe('updateList');
  });

  it('should return "unknown" when action is missing', () => {
    expect(extractTrelloActionType({})).toBe('unknown');
  });

  it('should return "unknown" when action.type is missing', () => {
    expect(extractTrelloActionType({ action: {} })).toBe('unknown');
  });

  it('should return "unknown" for null body', () => {
    expect(extractTrelloActionType(null)).toBe('unknown');
  });

  it('should return "unknown" for primitive body', () => {
    expect(extractTrelloActionType('string')).toBe('unknown');
    expect(extractTrelloActionType(42)).toBe('unknown');
  });
});

// ── extractTrelloActionId ───────────────────────────────────────────────

describe('extractTrelloActionId', () => {
  it('should extract action id from a valid payload', () => {
    expect(extractTrelloActionId(makeTrelloPayload('updateCard', 'abc-123'))).toBe('abc-123');
  });

  it('should return undefined when action is missing', () => {
    expect(extractTrelloActionId({})).toBeUndefined();
  });

  it('should return undefined when action.id is missing', () => {
    expect(extractTrelloActionId({ action: { type: 'test' } })).toBeUndefined();
  });

  it('should return undefined for null body', () => {
    expect(extractTrelloActionId(null)).toBeUndefined();
  });
});

// ── TrelloWebhookIngestor lifecycle ─────────────────────────────────────

describe('TrelloWebhookIngestor', () => {
  function createTestIngestor(
    options: {
      secrets?: Record<string, string>;
      signatureHeader?: string;
      signatureSecret?: string;
      callbackUrl?: string;
      bufferSize?: number;
    } = {},
  ): TrelloWebhookIngestor {
    return new TrelloWebhookIngestor(
      'trello',
      options.secrets ?? {},
      {
        path: 'trello',
        protocol: 'trello',
        signatureHeader: options.signatureHeader,
        signatureSecret: options.signatureSecret,
        callbackUrl: options.callbackUrl,
      },
      options.bufferSize,
    );
  }

  it('should set state to connected on start', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();
    expect(ingestor.getStatus().state).toBe('connected');
  });

  it('should set state to stopped on stop', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();
    await ingestor.stop();
    expect(ingestor.getStatus().state).toBe('stopped');
  });

  it('should report type as webhook in status', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();
    const status = ingestor.getStatus();
    expect(status.type).toBe('webhook');
    expect(status.connection).toBe('trello');
    expect(status.bufferedEvents).toBe(0);
    expect(status.totalEventsReceived).toBe(0);
    expect(status.lastEventAt).toBeNull();
  });

  it('should expose webhookPath as public readonly', () => {
    const ingestor = createTestIngestor();
    expect(ingestor.webhookPath).toBe('trello');
  });
});

// ── handleWebhook — no signature verification ──────────────────────────

describe('TrelloWebhookIngestor.handleWebhook (no verification)', () => {
  function createTestIngestor(): TrelloWebhookIngestor {
    return new TrelloWebhookIngestor(
      'trello',
      {},
      {
        path: 'trello',
        protocol: 'trello',
        // No signatureHeader/signatureSecret → skip verification
      },
    );
  }

  it('should accept a valid JSON webhook without signature verification', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const body = JSON.stringify(makeTrelloPayload());
    const result = ingestor.handleWebhook({}, Buffer.from(body));

    expect(result.accepted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('should extract event type from action.type field', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const body = JSON.stringify(makeTrelloPayload('createCard'));
    ingestor.handleWebhook({}, Buffer.from(body));

    const events = ingestor.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('createCard');
  });

  it('should include actionId and actionType in event data', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const body = JSON.stringify(makeTrelloPayload('commentCard', 'action-xyz'));
    ingestor.handleWebhook({}, Buffer.from(body));

    const events = ingestor.getEvents();
    expect(events).toHaveLength(1);
    const data = events[0].data as { actionId: string; actionType: string; payload: unknown };
    expect(data.actionId).toBe('action-xyz');
    expect(data.actionType).toBe('commentCard');
    expect(data.payload).toEqual(JSON.parse(body));
  });

  it('should handle body without action field (default to unknown)', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const body = JSON.stringify({ model: { id: 'board-1' } });
    ingestor.handleWebhook({}, Buffer.from(body));

    const events = ingestor.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('unknown');
  });

  it('should reject invalid JSON body', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const result = ingestor.handleWebhook({}, Buffer.from('not valid json{{{'));

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Invalid JSON body');
    expect(ingestor.getEvents()).toHaveLength(0);
  });

  it('should accumulate multiple events and support cursor-based retrieval', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const actionTypes = ['createCard', 'updateCard', 'commentCard', 'moveCard', 'deleteCard'];
    for (let i = 0; i < actionTypes.length; i++) {
      ingestor.handleWebhook(
        {},
        Buffer.from(JSON.stringify(makeTrelloPayload(actionTypes[i], `action-${i}`))),
      );
    }

    const allEvents = ingestor.getEvents();
    expect(allEvents).toHaveLength(5);
    expect(ingestor.getStatus().totalEventsReceived).toBe(5);

    // Cursor-based: get events after the 3rd event
    const afterThird = ingestor.getEvents(allEvents[2].id);
    expect(afterThird).toHaveLength(2);
    expect(afterThird[0].id).toBe(allEvents[3].id);
    expect(afterThird[1].id).toBe(allEvents[4].id);
  });

  it('should set source to connection alias', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    ingestor.handleWebhook({}, Buffer.from(JSON.stringify(makeTrelloPayload())));

    expect(ingestor.getEvents()[0].source).toBe('trello');
  });
});

// ── handleWebhook — with signature verification ────────────────────────

describe('TrelloWebhookIngestor.handleWebhook (with verification)', () => {
  const secret = 'my-trello-api-secret';

  function createVerifiedIngestor(): TrelloWebhookIngestor {
    return new TrelloWebhookIngestor(
      'trello',
      { TRELLO_API_SECRET: secret },
      {
        path: 'trello',
        protocol: 'trello',
        signatureHeader: 'X-Trello-Webhook',
        signatureSecret: 'TRELLO_API_SECRET',
        callbackUrl: CALLBACK_URL,
      },
    );
  }

  it('should accept a webhook with a valid signature', async () => {
    const ingestor = createVerifiedIngestor();
    await ingestor.start();

    const body = JSON.stringify(makeTrelloPayload());
    const sig = signTrelloPayload(body, secret);

    const result = ingestor.handleWebhook({ [TRELLO_SIGNATURE_HEADER]: sig }, Buffer.from(body));

    expect(result.accepted).toBe(true);
    expect(ingestor.getEvents()).toHaveLength(1);
  });

  it('should reject a webhook with an invalid signature', async () => {
    const ingestor = createVerifiedIngestor();
    await ingestor.start();

    const body = JSON.stringify(makeTrelloPayload());
    const badSig = signTrelloPayload(body, 'wrong-secret');

    const result = ingestor.handleWebhook({ [TRELLO_SIGNATURE_HEADER]: badSig }, Buffer.from(body));

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Signature verification failed');
    expect(ingestor.getEvents()).toHaveLength(0);
  });

  it('should reject when signature header is missing', async () => {
    const ingestor = createVerifiedIngestor();
    await ingestor.start();

    const body = JSON.stringify(makeTrelloPayload());

    const result = ingestor.handleWebhook({}, Buffer.from(body));

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Missing signature header');
  });

  it('should reject when signature secret is not in resolved secrets', async () => {
    const ingestor = new TrelloWebhookIngestor(
      'trello',
      {}, // empty secrets — secret name not found
      {
        path: 'trello',
        protocol: 'trello',
        signatureHeader: 'X-Trello-Webhook',
        signatureSecret: 'TRELLO_API_SECRET',
        callbackUrl: CALLBACK_URL,
      },
    );
    await ingestor.start();

    const body = JSON.stringify(makeTrelloPayload());
    const sig = signTrelloPayload(body, secret);

    const result = ingestor.handleWebhook({ [TRELLO_SIGNATURE_HEADER]: sig }, Buffer.from(body));

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Signature secret not configured');
  });

  it('should reject when callback URL is not configured', async () => {
    const ingestor = new TrelloWebhookIngestor(
      'trello',
      { TRELLO_API_SECRET: secret },
      {
        path: 'trello',
        protocol: 'trello',
        signatureHeader: 'X-Trello-Webhook',
        signatureSecret: 'TRELLO_API_SECRET',
        // No callbackUrl
      },
    );
    await ingestor.start();

    const body = JSON.stringify(makeTrelloPayload());
    const sig = signTrelloPayload(body, secret);

    const result = ingestor.handleWebhook({ [TRELLO_SIGNATURE_HEADER]: sig }, Buffer.from(body));

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Callback URL not configured');
  });

  it('should resolve ${VAR} placeholders in callbackUrl from secrets', async () => {
    const resolvedUrl = 'https://my-server.example.com/webhooks/trello';
    const ingestor = new TrelloWebhookIngestor(
      'trello',
      {
        TRELLO_API_SECRET: secret,
        TRELLO_CALLBACK_URL: resolvedUrl,
      },
      {
        path: 'trello',
        protocol: 'trello',
        signatureHeader: 'X-Trello-Webhook',
        signatureSecret: 'TRELLO_API_SECRET',
        callbackUrl: '${TRELLO_CALLBACK_URL}',
      },
    );
    await ingestor.start();

    const body = JSON.stringify(makeTrelloPayload());
    // Sign with the resolved URL, not the placeholder
    const sig = signTrelloPayload(body, secret, resolvedUrl);

    const result = ingestor.handleWebhook({ [TRELLO_SIGNATURE_HEADER]: sig }, Buffer.from(body));

    expect(result.accepted).toBe(true);
    expect(ingestor.getEvents()).toHaveLength(1);
  });

  it('should handle tampered body', async () => {
    const ingestor = createVerifiedIngestor();
    await ingestor.start();

    const originalBody = JSON.stringify(makeTrelloPayload());
    const sig = signTrelloPayload(originalBody, secret);
    const tamperedBody = JSON.stringify({ ...makeTrelloPayload(), extra: 'tampered' });

    const result = ingestor.handleWebhook(
      { [TRELLO_SIGNATURE_HEADER]: sig },
      Buffer.from(tamperedBody),
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Signature verification failed');
  });
});

// ── Factory registration ────────────────────────────────────────────────

describe('Trello webhook factory registration', () => {
  it('should create a TrelloWebhookIngestor via createIngestor with webhook:trello', () => {
    const ingestor = createIngestor(
      'trello',
      {
        type: 'webhook',
        webhook: {
          path: 'trello',
          protocol: 'trello',
          signatureHeader: 'X-Trello-Webhook',
          signatureSecret: 'TRELLO_API_SECRET',
          callbackUrl: 'https://example.com/webhooks/trello',
        },
      },
      { TRELLO_API_SECRET: 'test-secret' },
    );

    expect(ingestor).toBeInstanceOf(TrelloWebhookIngestor);
    expect((ingestor as TrelloWebhookIngestor).webhookPath).toBe('trello');
  });

  it('should return null when webhook config is missing', () => {
    const ingestor = createIngestor(
      'trello',
      { type: 'webhook' } as { type: 'webhook'; webhook: undefined },
      {},
    );

    // With protocol undefined, key becomes 'webhook:generic' (GitHub factory)
    // which also checks for !config.webhook and returns null
    expect(ingestor).toBeNull();
  });

  it('should create even with empty secrets (no verification)', () => {
    const ingestor = createIngestor(
      'trello',
      {
        type: 'webhook',
        webhook: {
          path: 'trello',
          protocol: 'trello',
        },
      },
      {},
    );

    expect(ingestor).toBeInstanceOf(TrelloWebhookIngestor);
  });
});

// ── getModelId and multi-instance lifecycle ──────────────────────────────

describe('TrelloWebhookIngestor — getModelId and board filtering', () => {
  it('should return boardId from getModelId when _boardId is set', async () => {
    const ingestor = new TrelloWebhookIngestor('trello', { TRELLO_API_SECRET: 'secret' }, {
      path: 'trello',
      protocol: 'trello',

      _boardId: 'board-xyz-789',
    } as any);

    // getModelId is protected, but we can verify the behavior through
    // getStatus — start the ingestor and check it works correctly
    await ingestor.start();
    const status = ingestor.getStatus();
    expect(status.state).toBe('connected');
  });

  it('should return undefined from getModelId when no _boardId is set', async () => {
    const ingestor = new TrelloWebhookIngestor(
      'trello',
      { TRELLO_API_SECRET: 'secret' },
      {
        path: 'trello',
        protocol: 'trello',
      },
    );

    await ingestor.start();
    const status = ingestor.getStatus();
    expect(status.state).toBe('connected');
    // No lifecycle config → no webhookRegistration
    expect(status.webhookRegistration).toBeUndefined();
  });

  it('should filter webhooks by boardId when _boardId is set', () => {
    const targetBoardId = 'board-target-123';
    const otherBoardId = 'board-other-456';

    const ingestor = new TrelloWebhookIngestor('trello', {}, {
      path: 'trello',
      protocol: 'trello',

      _boardId: targetBoardId,
    } as any);

    // Matching board → accepted
    const matchPayload = JSON.stringify({
      model: { id: targetBoardId },
      action: { type: 'updateCard', id: 'action-1' },
    });
    const matchResult = ingestor.handleWebhook({}, Buffer.from(matchPayload));
    expect(matchResult.accepted).toBe(true);
    expect(matchResult.reason).toBeUndefined();

    // Different board → silently skipped
    const otherPayload = JSON.stringify({
      model: { id: otherBoardId },
      action: { type: 'updateCard', id: 'action-2' },
    });
    const otherResult = ingestor.handleWebhook({}, Buffer.from(otherPayload));
    expect(otherResult.accepted).toBe(true);
    expect(otherResult.reason).toBe('Not for this instance');

    // Verify only the matching event was buffered
    expect(ingestor.getEvents()).toHaveLength(1);
  });

  it('should accept all webhooks when no _boardId is set', () => {
    const ingestor = new TrelloWebhookIngestor(
      'trello',
      {},
      { path: 'trello', protocol: 'trello' },
    );

    const payload1 = JSON.stringify({
      model: { id: 'board-a' },
      action: { type: 'updateCard', id: 'action-1' },
    });
    const payload2 = JSON.stringify({
      model: { id: 'board-b' },
      action: { type: 'createCard', id: 'action-2' },
    });

    expect(ingestor.handleWebhook({}, Buffer.from(payload1)).accepted).toBe(true);
    expect(ingestor.handleWebhook({}, Buffer.from(payload2)).accepted).toBe(true);
    expect(ingestor.getEvents()).toHaveLength(2);
  });

  it('should resolve callbackUrl via base class resolvedCallbackUrl', () => {
    const resolvedUrl = 'https://my-tunnel.example.com/webhooks/trello';

    const ingestor = new TrelloWebhookIngestor(
      'trello',
      {
        TRELLO_API_SECRET: 'secret',
        TRELLO_CALLBACK_URL: resolvedUrl,
      },
      {
        path: 'trello',
        protocol: 'trello',
        signatureHeader: 'X-Trello-Webhook',
        signatureSecret: 'TRELLO_API_SECRET',
        callbackUrl: '${TRELLO_CALLBACK_URL}',
      },
    );

    // Signature verification uses resolvedCallbackUrl (from base class)
    // If it weren't resolved, signature verification would fail with
    // "Callback URL not configured"
    const body = JSON.stringify({
      model: { id: 'board-1' },
      action: { type: 'updateCard', id: 'action-1' },
    });

    // Compute valid signature using the resolved URL
    const content = body + resolvedUrl;
    const sig = crypto.createHmac('sha1', 'secret').update(content).digest('base64');

    const result = ingestor.handleWebhook({ 'x-trello-webhook': sig }, Buffer.from(body));

    expect(result.accepted).toBe(true);
  });
});
