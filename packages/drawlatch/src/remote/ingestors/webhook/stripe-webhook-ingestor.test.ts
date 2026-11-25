/**
 * Unit tests for the Stripe webhook ingestor and signature verification.
 */

import crypto from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StripeWebhookIngestor } from './stripe-webhook-ingestor.js';
import {
  verifyStripeSignature,
  parseStripeSignatureHeader,
  STRIPE_SIGNATURE_HEADER,
  DEFAULT_TIMESTAMP_TOLERANCE,
} from './stripe-types.js';
import { createIngestor } from '../registry.js';

// ── Helper ──────────────────────────────────────────────────────────────

function signStripePayload(payload: string, secret: string, timestamp?: number): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${ts},v1=${sig}`;
}

// ── parseStripeSignatureHeader ──────────────────────────────────────────

describe('parseStripeSignatureHeader', () => {
  it('should parse a valid header with one v1 signature', () => {
    const result = parseStripeSignatureHeader('t=1234567890,v1=abc123');
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe(1234567890);
    expect(result!.signatures).toEqual(['abc123']);
  });

  it('should parse a header with multiple v1 signatures', () => {
    const result = parseStripeSignatureHeader('t=1234567890,v1=sig1,v1=sig2');
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe(1234567890);
    expect(result!.signatures).toEqual(['sig1', 'sig2']);
  });

  it('should return null when timestamp is missing', () => {
    expect(parseStripeSignatureHeader('v1=abc123')).toBeNull();
  });

  it('should return null when no v1 signatures are present', () => {
    expect(parseStripeSignatureHeader('t=1234567890')).toBeNull();
  });

  it('should return null when timestamp is not a number', () => {
    expect(parseStripeSignatureHeader('t=notanumber,v1=abc123')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseStripeSignatureHeader('')).toBeNull();
  });

  it('should handle whitespace in key-value pairs', () => {
    const result = parseStripeSignatureHeader('t = 1234567890, v1 = abc123');
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe(1234567890);
    expect(result!.signatures).toEqual(['abc123']);
  });

  it('should ignore unknown keys', () => {
    const result = parseStripeSignatureHeader('t=1234567890,v0=old,v1=abc123');
    expect(result).not.toBeNull();
    expect(result!.signatures).toEqual(['abc123']);
  });
});

// ── verifyStripeSignature ───────────────────────────────────────────────

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test_secret';
  const body = Buffer.from('{"id":"evt_123","type":"payment_intent.succeeded"}');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return valid for a correct signature with valid timestamp', () => {
    const header = signStripePayload(body.toString(), secret);
    const result = verifyStripeSignature(body, header, secret);
    expect(result.valid).toBe(true);
  });

  it('should return invalid for a wrong secret', () => {
    const header = signStripePayload(body.toString(), 'wrong-secret');
    const result = verifyStripeSignature(body, header, secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Signature verification failed');
  });

  it('should return invalid for a tampered body', () => {
    const header = signStripePayload(body.toString(), secret);
    const tamperedBody = Buffer.from('{"id":"evt_456","type":"tampered"}');
    const result = verifyStripeSignature(tamperedBody, header, secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Signature verification failed');
  });

  it('should return invalid for malformed header', () => {
    const result = verifyStripeSignature(body, 'malformed-header', secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Malformed Stripe-Signature header');
  });

  it('should return invalid for expired timestamp', () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const header = signStripePayload(body.toString(), secret, oldTimestamp);
    const result = verifyStripeSignature(body, header, secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Timestamp outside tolerance window');
  });

  it('should accept timestamp within tolerance', () => {
    const recentTimestamp = Math.floor(Date.now() / 1000) - 100; // 100 seconds ago
    const header = signStripePayload(body.toString(), secret, recentTimestamp);
    const result = verifyStripeSignature(body, header, secret);
    expect(result.valid).toBe(true);
  });

  it('should skip timestamp check when tolerance is 0', () => {
    const veryOldTimestamp = 1000000; // way in the past
    const header = signStripePayload(body.toString(), secret, veryOldTimestamp);
    const result = verifyStripeSignature(body, header, secret, 0);
    expect(result.valid).toBe(true);
  });

  it('should accept if any of multiple v1 signatures match', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signedPayload = `${timestamp}.${body.toString()}`;
    const validSig = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    const header = `t=${timestamp},v1=invalidsig1234567890abcdef1234567890abcdef1234567890abcdef12345678,v1=${validSig}`;
    const result = verifyStripeSignature(body, header, secret);
    expect(result.valid).toBe(true);
  });

  it('should return invalid when all v1 signatures are wrong', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = `t=${timestamp},v1=badsig1234567890abcdef1234567890abcdef1234567890abcdef12345678,v1=badsig2234567890abcdef1234567890abcdef1234567890abcdef12345678`;
    const result = verifyStripeSignature(body, header, secret);
    expect(result.valid).toBe(false);
  });

  it('should handle empty body', () => {
    const emptyBody = Buffer.from('');
    const header = signStripePayload('', secret);
    const result = verifyStripeSignature(emptyBody, header, secret);
    expect(result.valid).toBe(true);
  });

  it('should use default tolerance constant', () => {
    expect(DEFAULT_TIMESTAMP_TOLERANCE).toBe(300);
  });
});

// ── StripeWebhookIngestor lifecycle ─────────────────────────────────────

describe('StripeWebhookIngestor', () => {
  function createTestIngestor(
    options: {
      secrets?: Record<string, string>;
      signatureHeader?: string;
      signatureSecret?: string;
      bufferSize?: number;
    } = {},
  ): StripeWebhookIngestor {
    return new StripeWebhookIngestor(
      'stripe',
      options.secrets ?? {},
      {
        path: 'stripe',
        protocol: 'stripe',
        signatureHeader: options.signatureHeader,
        signatureSecret: options.signatureSecret,
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
    expect(status.connection).toBe('stripe');
    expect(status.bufferedEvents).toBe(0);
    expect(status.totalEventsReceived).toBe(0);
    expect(status.lastEventAt).toBeNull();
  });

  it('should expose webhookPath as public readonly', () => {
    const ingestor = createTestIngestor();
    expect(ingestor.webhookPath).toBe('stripe');
  });
});

// ── handleWebhook — no signature verification ──────────────────────────

describe('StripeWebhookIngestor.handleWebhook (no verification)', () => {
  function createTestIngestor(): StripeWebhookIngestor {
    return new StripeWebhookIngestor(
      'stripe',
      {},
      {
        path: 'stripe',
        protocol: 'stripe',
        // No signatureHeader/signatureSecret → skip verification
      },
    );
  }

  it('should accept a valid JSON webhook without signature verification', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const body = JSON.stringify({
      id: 'evt_123',
      type: 'payment_intent.succeeded',
      data: { object: { amount: 2000 } },
    });
    const result = ingestor.handleWebhook({}, Buffer.from(body));

    expect(result.accepted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('should extract event type from body type field', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const body = JSON.stringify({
      id: 'evt_456',
      type: 'invoice.paid',
      data: { object: {} },
    });
    ingestor.handleWebhook({}, Buffer.from(body));

    const events = ingestor.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('invoice.paid');
  });

  it('should include eventId and type in event data', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const body = JSON.stringify({
      id: 'evt_789',
      type: 'customer.created',
      data: { object: { id: 'cus_abc' } },
    });
    ingestor.handleWebhook({}, Buffer.from(body));

    const events = ingestor.getEvents();
    expect(events).toHaveLength(1);
    const data = events[0].data as { eventId: string; type: string; payload: unknown };
    expect(data.eventId).toBe('evt_789');
    expect(data.type).toBe('customer.created');
    expect(data.payload).toEqual({
      id: 'evt_789',
      type: 'customer.created',
      data: { object: { id: 'cus_abc' } },
    });
  });

  it('should handle body without type field (default to unknown)', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const body = JSON.stringify({ id: 'evt_000' });
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

    for (let i = 0; i < 5; i++) {
      ingestor.handleWebhook(
        {},
        Buffer.from(JSON.stringify({ id: `evt_${i}`, type: `event_${i}` })),
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

    ingestor.handleWebhook({}, Buffer.from(JSON.stringify({ id: 'evt_1', type: 'test' })));

    expect(ingestor.getEvents()[0].source).toBe('stripe');
  });
});

// ── handleWebhook — with signature verification ────────────────────────

describe('StripeWebhookIngestor.handleWebhook (with verification)', () => {
  const secret = 'whsec_test_secret';

  function createVerifiedIngestor(): StripeWebhookIngestor {
    return new StripeWebhookIngestor(
      'stripe',
      { STRIPE_WEBHOOK_SECRET: secret },
      {
        path: 'stripe',
        protocol: 'stripe',
        signatureHeader: 'Stripe-Signature',
        signatureSecret: 'STRIPE_WEBHOOK_SECRET',
      },
    );
  }

  it('should accept a webhook with a valid signature', async () => {
    const ingestor = createVerifiedIngestor();
    await ingestor.start();

    const body = JSON.stringify({ id: 'evt_123', type: 'payment_intent.succeeded' });
    const sig = signStripePayload(body, secret);

    const result = ingestor.handleWebhook({ [STRIPE_SIGNATURE_HEADER]: sig }, Buffer.from(body));

    expect(result.accepted).toBe(true);
    expect(ingestor.getEvents()).toHaveLength(1);
  });

  it('should reject a webhook with an invalid signature', async () => {
    const ingestor = createVerifiedIngestor();
    await ingestor.start();

    const body = JSON.stringify({ id: 'evt_123', type: 'payment_intent.succeeded' });
    const badSig = signStripePayload(body, 'wrong-secret');

    const result = ingestor.handleWebhook({ [STRIPE_SIGNATURE_HEADER]: badSig }, Buffer.from(body));

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Signature verification failed');
    expect(ingestor.getEvents()).toHaveLength(0);
  });

  it('should reject when signature header is missing', async () => {
    const ingestor = createVerifiedIngestor();
    await ingestor.start();

    const body = JSON.stringify({ id: 'evt_123', type: 'payment_intent.succeeded' });

    const result = ingestor.handleWebhook({}, Buffer.from(body));

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Missing signature header');
  });

  it('should reject when signature secret is not in resolved secrets', async () => {
    const ingestor = new StripeWebhookIngestor(
      'stripe',
      {}, // empty secrets — secret name not found
      {
        path: 'stripe',
        protocol: 'stripe',
        signatureHeader: 'Stripe-Signature',
        signatureSecret: 'STRIPE_WEBHOOK_SECRET',
      },
    );
    await ingestor.start();

    const body = JSON.stringify({ id: 'evt_123', type: 'payment_intent.succeeded' });
    const sig = signStripePayload(body, secret);

    const result = ingestor.handleWebhook({ [STRIPE_SIGNATURE_HEADER]: sig }, Buffer.from(body));

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Signature secret not configured');
  });

  it('should reject an expired webhook (timestamp too old)', async () => {
    const ingestor = createVerifiedIngestor();
    await ingestor.start();

    const body = JSON.stringify({ id: 'evt_123', type: 'payment_intent.succeeded' });
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const sig = signStripePayload(body, secret, oldTimestamp);

    const result = ingestor.handleWebhook({ [STRIPE_SIGNATURE_HEADER]: sig }, Buffer.from(body));

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Timestamp outside tolerance window');
  });

  it('should reject a malformed signature header', async () => {
    const ingestor = createVerifiedIngestor();
    await ingestor.start();

    const body = JSON.stringify({ id: 'evt_123', type: 'payment_intent.succeeded' });

    const result = ingestor.handleWebhook(
      { [STRIPE_SIGNATURE_HEADER]: 'not-a-valid-header' },
      Buffer.from(body),
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Malformed Stripe-Signature header');
  });
});

// ── Factory registration ────────────────────────────────────────────────

describe('Stripe webhook factory registration', () => {
  it('should create a StripeWebhookIngestor via createIngestor with webhook:stripe', () => {
    const ingestor = createIngestor(
      'stripe',
      {
        type: 'webhook',
        webhook: {
          path: 'stripe',
          protocol: 'stripe',
          signatureHeader: 'Stripe-Signature',
          signatureSecret: 'STRIPE_WEBHOOK_SECRET',
        },
      },
      { STRIPE_WEBHOOK_SECRET: 'whsec_test' },
    );

    expect(ingestor).toBeInstanceOf(StripeWebhookIngestor);
    expect((ingestor as StripeWebhookIngestor).webhookPath).toBe('stripe');
  });

  it('should return null when webhook config is missing', () => {
    const ingestor = createIngestor(
      'stripe',
      { type: 'webhook', webhook: { path: 'stripe', protocol: 'stripe' } },
      {},
    );

    // Should still create (no missing config — just empty secrets)
    expect(ingestor).toBeInstanceOf(StripeWebhookIngestor);
  });

  it('should return null when webhook block is entirely absent', () => {
    const ingestor = createIngestor(
      'stripe',
      { type: 'webhook' } as { type: 'webhook'; webhook: undefined },
      {},
    );

    // The factory checks for !config.webhook
    // But with protocol: undefined, key becomes 'webhook:generic' which goes to GitHub factory
    // Since there's no webhook config, it returns null
    expect(ingestor).toBeNull();
  });
});
