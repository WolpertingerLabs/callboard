/**
 * Listener output is scrubbed of secrets before it reaches the agent:
 *   - buffered events (poll_events / wait_for_events / triggers): withheld
 *     values, set by IngestorManager;
 *   - ingestor_status error text and webhook registration errors: every
 *     secret the listener holds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { BaseIngestor } from './base-ingestor.js';
import { IngestorManager } from './manager.js';
import { WebhookLifecycleManager } from './webhook/webhook-lifecycle-manager.js';
import type { RemoteServerConfig } from '../../shared/config.js';

const TOKEN = 'xapp-listener-token-1234';

class TestIngestor extends BaseIngestor {
  constructor(secrets: Record<string, string>) {
    super('test', 'poll', secrets);
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  push(data: unknown): void {
    this.pushEvent('thing', data);
  }
  fail(message: string): void {
    this.errorMessage = message;
  }
}

describe('BaseIngestor scrubbing', () => {
  it('scrubs withheld values from buffered events, leaving other values', () => {
    const ing = new TestIngestor({ APP_TOKEN: TOKEN, CHANNEL: 'general-channel' });
    ing.setWithheldSecrets({ APP_TOKEN: TOKEN });
    ing.push({ text: `token is ${TOKEN}`, nested: [{ [TOKEN]: 1 }], channel: 'general-channel' });
    const [event] = ing.getEvents();
    expect(event.data).toEqual({
      text: 'token is ${APP_TOKEN}',
      nested: [{ '${APP_TOKEN}': 1 }],
      channel: 'general-channel',
    });
  });

  it('leaves events alone when nothing is withheld', () => {
    const ing = new TestIngestor({ APP_TOKEN: TOKEN });
    const data = { text: TOKEN };
    ing.push(data);
    expect(ing.getEvents()[0].data).toBe(data);
  });

  it('scrubs every secret from the status error', () => {
    const ing = new TestIngestor({ APP_TOKEN: TOKEN, CHANNEL: 'general-channel' });
    ing.fail(`auth failed for ${TOKEN} on general-channel`);
    expect(ing.getStatus().error).toBe('auth failed for ${APP_TOKEN} on ${CHANNEL}');
  });
});

describe('WebhookLifecycleManager error scrubbing', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    // Fails every call, echoing the request URL like a careless upstream.
    server = http.createServer((req, res) => {
      res.statusCode = 401;
      res.end(`invalid token in ${decodeURIComponent(req.url!)}`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('scrubs secrets from a register failure that reaches ingestor_status', async () => {
    const lm = new WebhookLifecycleManager(
      {
        list: {
          method: 'GET',
          url: `${base}/tokens/\${TOKEN}/webhooks`,
          callbackUrlField: 'callbackURL',
          idField: 'id',
        },
        register: { method: 'POST', url: `${base}/tokens/\${TOKEN}/webhooks`, idField: 'id' },
      },
      { TOKEN },
    );
    const state = await lm.ensureRegistered('https://cb.example.com/hook');
    expect(state.registered).toBe(false);
    expect(state.error).toBe('Register failed (401): invalid token in /tokens/${TOKEN}/webhooks');
  });
});

describe('IngestorManager wires withheld secrets into listeners', () => {
  it('passes the route withheld values to each ingestor it starts', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      connectors: [
        {
          alias: 'hook',
          headers: { Authorization: 'Bearer ${API_TOKEN}' },
          secrets: { API_TOKEN: 'header-only-token', HOOK_SECRET: 'hook-secret', ROOM: 'room-1' },
          allowedEndpoints: ['https://api.example.com/**'],
          ingestor: {
            type: 'webhook',
            webhook: { path: 'hook', signatureHeader: 'X-Sig', signatureSecret: 'HOOK_SECRET' },
          },
        },
      ],
      callers: { c: { connections: ['hook'] } },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    expect((await manager.startOne('c', 'hook')).success).toBe(true);
    const ingestors = (manager as unknown as { ingestors: Map<string, unknown> }).ingestors;
    const [ingestor] = [...ingestors.values()] as { withheldValues: Record<string, string> }[];
    expect(ingestor.withheldValues).toEqual({
      API_TOKEN: 'header-only-token',
      HOOK_SECRET: 'hook-secret',
    });
    await manager.stopOne('c', 'hook');
  });
});
