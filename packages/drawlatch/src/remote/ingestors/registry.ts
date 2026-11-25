/**
 * Ingestor factory registry.
 *
 * Decouples the IngestorManager from specific ingestor implementations.
 * Each provider (Discord, Slack, webhook, poll) registers its own factory
 * function at module load time; the manager calls `createIngestor()` without
 * knowing which concrete classes exist.
 */

import type { BaseIngestor } from './base-ingestor.js';
import type { IngestorConfig } from './types.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('ingestor');

/** Signature for a factory that creates an ingestor from its config. */
type IngestorFactory = (
  connectionAlias: string,
  config: IngestorConfig,
  secrets: Record<string, string>,
  bufferSize?: number,
  instanceId?: string,
) => BaseIngestor | null;

/** Registered factories keyed by type string (e.g., 'websocket:discord'). */
const factories = new Map<string, IngestorFactory>();

/**
 * Register a factory for a given ingestor key.
 *
 * Convention for keys:
 * - WebSocket protocols: `websocket:<protocol>` (e.g., `websocket:discord`, `websocket:slack`)
 * - Webhook protocols: `webhook:<protocol>` (e.g., `webhook:generic` for GitHub, `webhook:stripe`)
 * - Other types: the type name directly (e.g., `poll`)
 */
export function registerIngestorFactory(key: string, factory: IngestorFactory): void {
  factories.set(key, factory);
}

/**
 * Create an ingestor instance using the registered factory for its config type.
 *
 * For WebSocket ingestors, the key is `websocket:<protocol>`.
 * For Webhook ingestors, the key is `webhook:<protocol>` (default: `webhook:generic`).
 * For other types, the key is just the type name.
 *
 * Returns `null` if no factory is registered or if the factory declines to create.
 */
export function createIngestor(
  connectionAlias: string,
  config: IngestorConfig,
  secrets: Record<string, string>,
  bufferSize?: number,
  instanceId?: string,
): BaseIngestor | null {
  const key =
    config.type === 'websocket'
      ? `websocket:${config.websocket?.protocol ?? 'generic'}`
      : config.type === 'webhook'
        ? `webhook:${config.webhook?.protocol ?? 'generic'}`
        : config.type;

  const factory = factories.get(key);
  if (!factory) {
    log.error(`No factory registered for "${key}" (${connectionAlias})`);
    return null;
  }

  return factory(connectionAlias, config, secrets, bufferSize, instanceId);
}
