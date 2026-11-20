/**
 * E2E test: GitHub webhook ingestor.
 *
 * Boots a real Express server, sends properly-signed webhook payloads
 * to /webhooks/github, and verifies events are buffered and retrievable
 * via the IngestorManager.
 *
 * Requires: GITHUB_WEBHOOK_SECRET in .env.e2e (GITHUB_TOKEN optional,
 * only needed for test_connection verification).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import {
  loadE2EEnv,
  checkEnvVars,
  buildE2EConfig,
  bootServer,
  signGitHubPayload,
  INGESTED_EVENT_SHAPE,
  type E2EServer,
} from './setup.js';

// ── Skip guard ──────────────────────────────────────────────────────────

loadE2EEnv();
const REQUIRED_VARS = ['GITHUB_WEBHOOK_SECRET'];
const missing = checkEnvVars(REQUIRED_VARS);
const shouldSkip = missing.length > 0;

describe.skipIf(shouldSkip)('GitHub webhook e2e', () => {
  if (shouldSkip) {
    it.skip(`skipped — missing env vars: ${missing.join(', ')}`, () => {
      /* noop */
    });
    return;
  }

  let e2e: E2EServer;
  const secret = process.env.GITHUB_WEBHOOK_SECRET!;

  beforeAll(async () => {
    const config = buildE2EConfig(['github'], {
      env: {
        GITHUB_WEBHOOK_SECRET: secret,
        // No GITHUB_WEBHOOK_URL — prevents lifecycle registration attempts
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? 'unused',
      },
    });
    e2e = await bootServer(config);
  });

  afterAll(async () => {
    await e2e.teardown();
  });

  it('accepts a properly signed webhook and buffers the event', async () => {
    const deliveryId = crypto.randomUUID();
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      repository: { full_name: 'test-org/test-repo' },
      pusher: { name: 'e2e-test' },
      commits: [{ id: 'abc123', message: 'test commit' }],
    });

    const signature = signGitHubPayload(body, secret);

    const res = await fetch(`${e2e.baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': deliveryId,
        'X-Hub-Signature-256': signature,
      },
      body,
    });

    expect(res.status).toBe(200);

    const events = e2e.ingestorManager.getEvents('e2e-client', 'github');
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event.eventType).toBe('push');
    expect(event.source).toBe('github');
    expect(event.callerAlias).toBe('e2e-client');
    expect(event.data).toMatchObject({
      deliveryId,
      event: 'push',
      payload: expect.objectContaining({
        ref: 'refs/heads/main',
        repository: { full_name: 'test-org/test-repo' },
      }),
    });
  });

  it('rejects a webhook with an invalid signature', async () => {
    const body = JSON.stringify({ repository: { full_name: 'test/repo' } });

    const res = await fetch(`${e2e.baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': crypto.randomUUID(),
        'X-Hub-Signature-256':
          'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body,
    });

    expect(res.status).toBe(403);
  });

  it('event shape matches IngestedEvent interface', () => {
    const events = e2e.ingestorManager.getEvents('e2e-client', 'github');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject(INGESTED_EVENT_SHAPE);
  });

  it('deduplicates events by delivery ID', async () => {
    const deliveryId = crypto.randomUUID();
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      repository: { full_name: 'test-org/test-repo' },
    });
    const signature = signGitHubPayload(body, secret);

    const headers = {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'push',
      'X-GitHub-Delivery': deliveryId,
      'X-Hub-Signature-256': signature,
    };

    // Send the same delivery twice
    await fetch(`${e2e.baseUrl}/webhooks/github`, { method: 'POST', headers, body });
    await fetch(`${e2e.baseUrl}/webhooks/github`, { method: 'POST', headers, body });

    // Count events with this specific delivery ID
    const events = e2e.ingestorManager.getEvents('e2e-client', 'github');
    const matching = events.filter((e) => (e.data as any)?.deliveryId === deliveryId);
    expect(matching).toHaveLength(1);
  });
});
