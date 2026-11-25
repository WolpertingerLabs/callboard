/**
 * Shared E2E test setup for connection ingestor tests.
 *
 * Provides helpers to:
 *   - Load .env.e2e environment variables
 *   - Build a RemoteServerConfig with in-memory keys and requested connections
 *   - Boot an Express server on a random port
 *   - Generate valid webhook signatures (GitHub, Trello)
 *   - Wait for ingestor state transitions and event arrival
 */

import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import { expect } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from '../../server.js';
import { generateKeyBundle, extractPublicKeys } from '../../../shared/crypto/index.js';
import { IngestorManager } from '../manager.js';
import type { RemoteServerConfig } from '../../../shared/config.js';
import type { IngestedEvent, IngestorState } from '../types.js';

// ── Env loading ─────────────────────────────────────────────────────────

/** Load .env.e2e from the project root (idempotent). */
let envLoaded = false;
export function loadE2EEnv(): void {
  if (envLoaded) return;
  dotenv.config({ path: path.resolve(import.meta.dirname, '../../../../.env.e2e') });
  envLoaded = true;
}

/**
 * Check that all required env vars are set.
 * Returns the missing var names (empty array = all present).
 */
export function checkEnvVars(vars: string[]): string[] {
  loadE2EEnv();
  return vars.filter((v) => !process.env[v]);
}

// ── Config builder ──────────────────────────────────────────────────────

/**
 * Build a RemoteServerConfig for E2E tests.
 *
 * Creates a single caller ("e2e-client") with the requested connections.
 * Env vars are injected into caller.env so secret resolution works against
 * process.env (already loaded by loadE2EEnv).
 */
export function buildE2EConfig(
  connections: string[],
  opts?: {
    env?: Record<string, string>;
    ingestorOverrides?: Record<string, Record<string, unknown>>;
  },
): RemoteServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    callers: {
      'e2e-client': {
        connections,
        env: opts?.env,
        ingestorOverrides: opts?.ingestorOverrides,
      },
    },
    rateLimitPerMinute: 600,
  };
}

// ── Server boot ─────────────────────────────────────────────────────────

export interface E2EServer {
  server: Server;
  baseUrl: string;
  ingestorManager: IngestorManager;
  /** Gracefully shut down server and stop all ingestors. */
  teardown: () => Promise<void>;
}

/**
 * Boot an Express server with the given config on a random port.
 * Starts all ingestors and returns handles for testing.
 */
export async function bootServer(config: RemoteServerConfig): Promise<E2EServer> {
  const serverKeys = generateKeyBundle();
  const clientKeys = generateKeyBundle();
  const clientPub = extractPublicKeys(clientKeys);

  const ingestorManager = new IngestorManager(config);

  const app = createApp({
    config,
    ownKeys: serverKeys,
    authorizedPeers: [{ alias: 'e2e-client', keys: clientPub }],
    ingestorManager,
    disableRateLimiting: true,
  });

  // Start ingestors
  await ingestorManager.startAll();

  // Listen on random port
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    server,
    baseUrl,
    ingestorManager,
    teardown: async () => {
      await ingestorManager.stopAll();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// ── Signature helpers ───────────────────────────────────────────────────

/** Generate a valid GitHub HMAC-SHA256 signature for a raw body. */
export function signGitHubPayload(rawBody: string | Buffer, secret: string): string {
  const buf = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
  const sig = crypto.createHmac('sha256', secret).update(buf).digest('hex');
  return `sha256=${sig}`;
}

/** Generate a valid Trello HMAC-SHA1 base64 signature for body + callbackUrl. */
export function signTrelloPayload(
  rawBody: string | Buffer,
  callbackUrl: string,
  secret: string,
): string {
  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
  return crypto
    .createHmac('sha1', secret)
    .update(bodyStr + callbackUrl)
    .digest('base64');
}

// ── Polling helpers ─────────────────────────────────────────────────────

/**
 * Wait for an ingestor to reach a specific state.
 * Polls every 250ms until the timeout is reached.
 */
export async function waitForIngestorState(
  manager: IngestorManager,
  callerAlias: string,
  connection: string,
  targetState: IngestorState,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = manager.getStatuses(callerAlias);
    const status = statuses.find((s) => s.connection === connection);
    if (status?.state === targetState) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Timed out waiting for ${connection} to reach state "${targetState}" (${timeoutMs}ms)`,
  );
}

/**
 * Poll until at least one event appears for a connection.
 * Returns the events array once non-empty.
 */
export async function pollUntilEvent(
  manager: IngestorManager,
  callerAlias: string,
  connection: string,
  timeoutMs = 10_000,
): Promise<IngestedEvent[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const events = manager.getEvents(callerAlias, connection);
    if (events.length > 0) return events;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for events from ${connection} (${timeoutMs}ms)`);
}

// ── Shared assertions ───────────────────────────────────────────────────

/** Common shape every IngestedEvent must satisfy (for use with toMatchObject). */
export const INGESTED_EVENT_SHAPE = {
  id: expect.any(Number),
  idempotencyKey: expect.any(String),
  receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
  receivedAtMs: expect.any(Number),
  callerAlias: 'e2e-client',
  source: expect.any(String),
  eventType: expect.any(String),
  data: expect.anything(),
};
