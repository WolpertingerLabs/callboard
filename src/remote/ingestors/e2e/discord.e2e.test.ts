/**
 * E2E test: Discord Gateway (WebSocket) ingestor.
 *
 * Boots a real Express server, connects to the Discord Gateway with a real
 * bot token, sends a message to a test channel via the REST API, and verifies
 * the MESSAGE_CREATE event is received and buffered.
 *
 * Requires: DISCORD_BOT_TOKEN, DISCORD_E2E_CHANNEL_ID, DISCORD_E2E_GUILD_ID
 * in .env.e2e.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  loadE2EEnv,
  checkEnvVars,
  buildE2EConfig,
  bootServer,
  waitForIngestorState,
  pollUntilEvent,
  INGESTED_EVENT_SHAPE,
  type E2EServer,
} from './setup.js';

// ── Skip guard ──────────────────────────────────────────────────────────

loadE2EEnv();
const REQUIRED_VARS = ['DISCORD_BOT_TOKEN', 'DISCORD_E2E_CHANNEL_ID', 'DISCORD_E2E_GUILD_ID'];
const missing = checkEnvVars(REQUIRED_VARS);
const shouldSkip = missing.length > 0;

describe.skipIf(shouldSkip)('Discord Gateway e2e', () => {
  if (shouldSkip) {
    it.skip(`skipped — missing env vars: ${missing.join(', ')}`, () => {
      /* noop */
    });
    return;
  }

  let e2e: E2EServer;
  let testMessageId: string | undefined;
  const botToken = process.env.DISCORD_BOT_TOKEN!;
  const channelId = process.env.DISCORD_E2E_CHANNEL_ID!;
  const guildId = process.env.DISCORD_E2E_GUILD_ID!;

  beforeAll(async () => {
    const config = buildE2EConfig(['discord-bot'], {
      env: {
        DISCORD_BOT_TOKEN: botToken,
      },
      ingestorOverrides: {
        'discord-bot': {
          guildIds: [guildId],
          channelIds: [channelId],
        },
      },
    });

    e2e = await bootServer(config);

    // Wait for the Gateway to reach "connected" state (READY received)
    await waitForIngestorState(
      e2e.ingestorManager,
      'e2e-client',
      'discord-bot',
      'connected',
      20_000,
    );
  }, 30_000);

  afterAll(async () => {
    // Clean up the test message
    if (testMessageId) {
      try {
        await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${testMessageId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bot ${botToken}` },
        });
      } catch {
        // Best-effort cleanup
      }
    }
    await e2e.teardown();
  });

  it('receives MESSAGE_CREATE from the Gateway', async () => {
    const nonce = `e2e-${Date.now()}`;

    // Send a message to the test channel via REST API
    const sendRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: `Drawlatch E2E test message (${nonce})`,
      }),
    });

    expect(sendRes.ok).toBe(true);
    const messageData = (await sendRes.json()) as { id: string };
    testMessageId = messageData.id;

    // Poll until the MESSAGE_CREATE event arrives via the Gateway
    const events = await pollUntilEvent(e2e.ingestorManager, 'e2e-client', 'discord-bot', 15_000);

    const msgEvent = events.find(
      (e) => e.eventType === 'MESSAGE_CREATE' && (e.data as any)?.content?.includes(nonce),
    );
    expect(msgEvent).toBeDefined();
    expect(msgEvent!.data).toMatchObject({
      channel_id: channelId,
      content: expect.stringContaining(nonce),
      author: expect.objectContaining({ bot: true }),
    });
  }, 25_000);

  it('ingestor status shows connected state', () => {
    const statuses = e2e.ingestorManager.getStatuses('e2e-client');
    const discordStatus = statuses.find((s) => s.connection === 'discord-bot');

    expect(discordStatus).toBeDefined();
    expect(discordStatus!.state).toBe('connected');
    expect(discordStatus!.type).toBe('websocket');
  });

  it('event shape matches IngestedEvent interface', () => {
    const events = e2e.ingestorManager.getEvents('e2e-client', 'discord-bot');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject(INGESTED_EVENT_SHAPE);
  });
});
