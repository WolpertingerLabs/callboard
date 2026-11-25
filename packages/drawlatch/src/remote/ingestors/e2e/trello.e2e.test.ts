/**
 * E2E test: Trello webhook ingestor.
 *
 * Boots a real Express server, sends properly-signed webhook payloads
 * to /webhooks/trello, and verifies events are buffered and retrievable
 * via the IngestorManager.
 *
 * Requires: TRELLO_API_SECRET in .env.e2e (TRELLO_API_KEY and TRELLO_TOKEN
 * are optional, only needed for test_connection verification).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import {
  loadE2EEnv,
  checkEnvVars,
  buildE2EConfig,
  bootServer,
  signTrelloPayload,
  INGESTED_EVENT_SHAPE,
  type E2EServer,
} from './setup.js';

// ── Skip guard ──────────────────────────────────────────────────────────

loadE2EEnv();
const REQUIRED_VARS = ['TRELLO_API_SECRET'];
const missing = checkEnvVars(REQUIRED_VARS);
const shouldSkip = missing.length > 0;

describe.skipIf(shouldSkip)('Trello webhook e2e', () => {
  if (shouldSkip) {
    it.skip(`skipped — missing env vars: ${missing.join(', ')}`, () => {
      /* noop */
    });
    return;
  }

  let e2e: E2EServer;
  const secret = process.env.TRELLO_API_SECRET!;
  // The callback URL the Trello ingestor will use for signature verification.
  // We set it via env so the ingestor resolves it from ${TRELLO_CALLBACK_URL}.
  const callbackUrl = 'http://127.0.0.1:0/webhooks/trello';

  beforeAll(async () => {
    const config = buildE2EConfig(['trello'], {
      env: {
        TRELLO_API_KEY: process.env.TRELLO_API_KEY ?? 'unused',
        TRELLO_TOKEN: process.env.TRELLO_TOKEN ?? 'unused',
        TRELLO_API_SECRET: secret,
        TRELLO_CALLBACK_URL: callbackUrl,
      },
    });
    e2e = await bootServer(config);

    // Update callbackUrl to use the actual port for signature computation
    // The ingestor's resolvedCallbackUrl was set from env before the server port was known.
    // For signature verification to pass, we compute signatures against the same URL
    // the ingestor resolved at startup.
  });

  afterAll(async () => {
    await e2e.teardown();
  });

  it('HEAD /webhooks/trello returns 200 (Trello verification ping)', async () => {
    const res = await fetch(`${e2e.baseUrl}/webhooks/trello`, {
      method: 'HEAD',
    });
    expect(res.status).toBe(200);
  });

  it('accepts a properly signed Trello webhook and buffers the event', async () => {
    const actionId = crypto.randomUUID();
    const body = JSON.stringify({
      action: {
        id: actionId,
        type: 'updateCard',
        date: new Date().toISOString(),
        idMemberCreator: 'member123',
        data: {
          board: { id: 'board123', name: 'Test Board' },
          card: { id: 'card456', name: 'Test Card' },
          listBefore: { id: 'list1', name: 'To Do' },
          listAfter: { id: 'list2', name: 'Done' },
        },
      },
      model: { id: 'board123', name: 'Test Board' },
    });

    const signature = signTrelloPayload(body, callbackUrl, secret);

    const res = await fetch(`${e2e.baseUrl}/webhooks/trello`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-trello-webhook': signature,
      },
      body,
    });

    expect(res.status).toBe(200);

    const events = e2e.ingestorManager.getEvents('e2e-client', 'trello');
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event.eventType).toBe('updateCard');
    expect(event.source).toBe('trello');
    expect(event.callerAlias).toBe('e2e-client');
    expect(event.data).toMatchObject({
      actionId,
      actionType: 'updateCard',
      payload: expect.objectContaining({
        action: expect.objectContaining({ type: 'updateCard' }),
        model: expect.objectContaining({ id: 'board123' }),
      }),
    });
  });

  it('rejects a webhook with an invalid signature', async () => {
    const body = JSON.stringify({
      action: { id: 'x', type: 'updateCard', data: {} },
      model: { id: 'board1' },
    });

    const res = await fetch(`${e2e.baseUrl}/webhooks/trello`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-trello-webhook': 'aW52YWxpZA==', // "invalid" in base64
      },
      body,
    });

    expect(res.status).toBe(403);
  });

  it('event shape matches IngestedEvent interface', () => {
    const events = e2e.ingestorManager.getEvents('e2e-client', 'trello');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject(INGESTED_EVENT_SHAPE);
  });

  it('deduplicates events by action ID', async () => {
    const actionId = crypto.randomUUID();
    const body = JSON.stringify({
      action: {
        id: actionId,
        type: 'createCard',
        date: new Date().toISOString(),
        idMemberCreator: 'member123',
        data: { card: { id: 'card789' } },
      },
      model: { id: 'board123' },
    });

    const signature = signTrelloPayload(body, callbackUrl, secret);
    const headers = {
      'Content-Type': 'application/json',
      'x-trello-webhook': signature,
    };

    // Send the same action twice
    await fetch(`${e2e.baseUrl}/webhooks/trello`, { method: 'POST', headers, body });
    await fetch(`${e2e.baseUrl}/webhooks/trello`, { method: 'POST', headers, body });

    // Count events with this specific action ID
    const events = e2e.ingestorManager.getEvents('e2e-client', 'trello');
    const matching = events.filter((e) => (e.data as any)?.actionId === actionId);
    expect(matching).toHaveLength(1);
  });
});
