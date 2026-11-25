/**
 * Unit tests for the GitHub webhook ingestor and signature verification.
 */

import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { GitHubWebhookIngestor } from './github-webhook-ingestor.js';
import {
  verifyGitHubSignature,
  extractGitHubHeaders,
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  GITHUB_DELIVERY_HEADER,
} from './github-types.js';
import { createIngestor } from '../registry.js';

// ── Helper ──────────────────────────────────────────────────────────────

function signPayload(payload: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${hmac}`;
}

// ── verifyGitHubSignature ───────────────────────────────────────────────

describe('verifyGitHubSignature', () => {
  const secret = 'test-webhook-secret';
  const body = Buffer.from('{"action":"opened"}');

  it('should return true for a valid HMAC-SHA256 signature', () => {
    const sig = signPayload(body.toString(), secret);
    expect(verifyGitHubSignature(body, sig, secret)).toBe(true);
  });

  it('should return false for an invalid signature (wrong secret)', () => {
    const sig = signPayload(body.toString(), 'wrong-secret');
    expect(verifyGitHubSignature(body, sig, secret)).toBe(false);
  });

  it('should return false when signature does not start with sha256=', () => {
    const hmac = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyGitHubSignature(body, `md5=${hmac}`, secret)).toBe(false);
  });

  it('should return false for an invalid hex string', () => {
    expect(verifyGitHubSignature(body, 'sha256=not-valid-hex!', secret)).toBe(false);
  });

  it('should return false when signature has wrong length', () => {
    expect(verifyGitHubSignature(body, 'sha256=abcd', secret)).toBe(false);
  });

  it('should handle empty body', () => {
    const emptyBody = Buffer.from('');
    const sig = signPayload('', secret);
    expect(verifyGitHubSignature(emptyBody, sig, secret)).toBe(true);
  });
});

// ── extractGitHubHeaders ────────────────────────────────────────────────

describe('extractGitHubHeaders', () => {
  it('should extract all GitHub headers when present', () => {
    const headers = {
      [GITHUB_EVENT_HEADER]: 'push',
      [GITHUB_SIGNATURE_HEADER]: 'sha256=abc123',
      [GITHUB_DELIVERY_HEADER]: 'uuid-1234',
    };
    const result = extractGitHubHeaders(headers);
    expect(result.event).toBe('push');
    expect(result.signature).toBe('sha256=abc123');
    expect(result.deliveryId).toBe('uuid-1234');
  });

  it('should default event to "unknown" when header is missing', () => {
    const result = extractGitHubHeaders({});
    expect(result.event).toBe('unknown');
    expect(result.signature).toBeUndefined();
    expect(result.deliveryId).toBeUndefined();
  });

  it('should handle array-valued headers (take first)', () => {
    const headers = {
      [GITHUB_EVENT_HEADER]: ['push', 'pull_request'],
      [GITHUB_SIGNATURE_HEADER]: ['sha256=first', 'sha256=second'],
    };
    const result = extractGitHubHeaders(headers);
    expect(result.event).toBe('push');
    expect(result.signature).toBe('sha256=first');
  });
});

// ── GitHubWebhookIngestor lifecycle ─────────────────────────────────────

describe('GitHubWebhookIngestor', () => {
  function createTestIngestor(
    options: {
      secrets?: Record<string, string>;
      signatureHeader?: string;
      signatureSecret?: string;
      bufferSize?: number;
    } = {},
  ): GitHubWebhookIngestor {
    return new GitHubWebhookIngestor(
      'github',
      options.secrets ?? {},
      {
        path: 'github',
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
    expect(status.connection).toBe('github');
    expect(status.bufferedEvents).toBe(0);
    expect(status.totalEventsReceived).toBe(0);
    expect(status.lastEventAt).toBeNull();
  });

  it('should expose webhookPath as public readonly', () => {
    const ingestor = createTestIngestor();
    expect(ingestor.webhookPath).toBe('github');
  });
});

// ── handleWebhook — no signature verification ──────────────────────────

describe('GitHubWebhookIngestor.handleWebhook (no verification)', () => {
  function createTestIngestor(): GitHubWebhookIngestor {
    return new GitHubWebhookIngestor(
      'github',
      {},
      {
        path: 'github',
        // No signatureHeader/signatureSecret → skip verification
      },
    );
  }

  it('should accept a valid JSON webhook without signature verification', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const body = JSON.stringify({ action: 'opened', number: 42 });
    const result = ingestor.handleWebhook(
      { [GITHUB_EVENT_HEADER]: 'pull_request' },
      Buffer.from(body),
    );

    expect(result.accepted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('should extract event type from X-GitHub-Event header', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const body = JSON.stringify({ ref: 'refs/heads/main' });
    ingestor.handleWebhook({ [GITHUB_EVENT_HEADER]: 'push' }, Buffer.from(body));

    const events = ingestor.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('push');
  });

  it('should include deliveryId in event data', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const body = JSON.stringify({ action: 'created' });
    ingestor.handleWebhook(
      {
        [GITHUB_EVENT_HEADER]: 'issues',
        [GITHUB_DELIVERY_HEADER]: 'delivery-uuid-123',
      },
      Buffer.from(body),
    );

    const events = ingestor.getEvents();
    expect(events).toHaveLength(1);
    const data = events[0].data as { deliveryId: string; event: string; payload: unknown };
    expect(data.deliveryId).toBe('delivery-uuid-123');
    expect(data.event).toBe('issues');
    expect(data.payload).toEqual({ action: 'created' });
  });

  it('should reject invalid JSON body', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    const result = ingestor.handleWebhook(
      { [GITHUB_EVENT_HEADER]: 'push' },
      Buffer.from('not valid json{{{'),
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Invalid JSON body');
    expect(ingestor.getEvents()).toHaveLength(0);
  });

  it('should accumulate multiple events and support cursor-based retrieval', async () => {
    const ingestor = createTestIngestor();
    await ingestor.start();

    for (let i = 0; i < 5; i++) {
      ingestor.handleWebhook(
        { [GITHUB_EVENT_HEADER]: `event_${i}` },
        Buffer.from(JSON.stringify({ i })),
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

    ingestor.handleWebhook({ [GITHUB_EVENT_HEADER]: 'push' }, Buffer.from(JSON.stringify({})));

    expect(ingestor.getEvents()[0].source).toBe('github');
  });
});

// ── handleWebhook — with signature verification ────────────────────────

describe('GitHubWebhookIngestor.handleWebhook (with verification)', () => {
  const secret = 'my-webhook-secret';

  function createVerifiedIngestor(): GitHubWebhookIngestor {
    return new GitHubWebhookIngestor(
      'github',
      { GITHUB_WEBHOOK_SECRET: secret },
      {
        path: 'github',
        signatureHeader: 'X-Hub-Signature-256',
        signatureSecret: 'GITHUB_WEBHOOK_SECRET',
      },
    );
  }

  it('should accept a webhook with a valid signature', async () => {
    const ingestor = createVerifiedIngestor();
    await ingestor.start();

    const body = JSON.stringify({ action: 'opened' });
    const sig = signPayload(body, secret);

    const result = ingestor.handleWebhook(
      {
        [GITHUB_EVENT_HEADER]: 'pull_request',
        [GITHUB_SIGNATURE_HEADER]: sig,
      },
      Buffer.from(body),
    );

    expect(result.accepted).toBe(true);
    expect(ingestor.getEvents()).toHaveLength(1);
  });

  it('should reject a webhook with an invalid signature', async () => {
    const ingestor = createVerifiedIngestor();
    await ingestor.start();

    const body = JSON.stringify({ action: 'opened' });
    const badSig = signPayload(body, 'wrong-secret');

    const result = ingestor.handleWebhook(
      {
        [GITHUB_EVENT_HEADER]: 'pull_request',
        [GITHUB_SIGNATURE_HEADER]: badSig,
      },
      Buffer.from(body),
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Signature verification failed');
    expect(ingestor.getEvents()).toHaveLength(0);
  });

  it('should reject when signature header is missing', async () => {
    const ingestor = createVerifiedIngestor();
    await ingestor.start();

    const body = JSON.stringify({ action: 'opened' });

    const result = ingestor.handleWebhook({ [GITHUB_EVENT_HEADER]: 'push' }, Buffer.from(body));

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Missing signature header');
  });

  it('should reject when signature secret is not in resolved secrets', async () => {
    const ingestor = new GitHubWebhookIngestor(
      'github',
      {}, // empty secrets — secret name not found
      {
        path: 'github',
        signatureHeader: 'X-Hub-Signature-256',
        signatureSecret: 'GITHUB_WEBHOOK_SECRET',
      },
    );
    await ingestor.start();

    const body = JSON.stringify({ action: 'opened' });
    const sig = signPayload(body, secret);

    const result = ingestor.handleWebhook(
      {
        [GITHUB_EVENT_HEADER]: 'push',
        [GITHUB_SIGNATURE_HEADER]: sig,
      },
      Buffer.from(body),
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Signature secret not configured');
  });
});

// ── Factory registration ────────────────────────────────────────────────

describe('Webhook factory registration', () => {
  it('should create a GitHubWebhookIngestor via createIngestor with type webhook', () => {
    const ingestor = createIngestor(
      'github',
      {
        type: 'webhook',
        webhook: {
          path: 'github',
          signatureHeader: 'X-Hub-Signature-256',
          signatureSecret: 'GITHUB_WEBHOOK_SECRET',
        },
      },
      { GITHUB_WEBHOOK_SECRET: 'test-secret' },
    );

    expect(ingestor).toBeInstanceOf(GitHubWebhookIngestor);
    expect((ingestor as GitHubWebhookIngestor).webhookPath).toBe('github');
  });

  it('should return null when webhook config is missing', () => {
    const ingestor = createIngestor('github', { type: 'webhook' }, {});

    expect(ingestor).toBeNull();
  });
});
