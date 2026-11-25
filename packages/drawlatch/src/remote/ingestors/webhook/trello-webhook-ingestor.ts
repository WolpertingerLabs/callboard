/**
 * Trello Webhook ingestor.
 *
 * A concrete webhook ingestor that handles Trello webhook events with optional
 * HMAC-SHA1 signature verification.
 *
 * Extends the generic `WebhookIngestor` base class, implementing Trello-specific
 * signature verification (via `X-Trello-Webhook` header), event type extraction
 * (from the JSON body's `action.type` field), and data shaping.
 *
 * Trello's signature scheme is unique: the HMAC is computed over
 * `${rawBody}${callbackURL}`, requiring the callback URL to be configured.
 *
 * @see https://developer.atlassian.com/cloud/trello/guides/rest-api/webhooks/
 */

import { registerIngestorFactory } from '../registry.js';
import { WebhookIngestor } from './base-webhook-ingestor.js';
import type { WebhookIngestorConfig } from '../types.js';
import {
  verifyTrelloSignature,
  extractTrelloActionType,
  extractTrelloActionId,
  TRELLO_SIGNATURE_HEADER,
} from './trello-types.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('webhook');

// ── Trello Webhook Ingestor ─────────────────────────────────────────────

export class TrelloWebhookIngestor extends WebhookIngestor {
  /**
   * Board ID filter for multi-instance support.
   * When set, only webhooks from this specific board are accepted.
   * Set via `_boardId` on the webhook config (injected by IngestorManager).
   */
  private readonly boardId: string | undefined;

  constructor(
    connectionAlias: string,
    secrets: Record<string, string>,
    webhookConfig: WebhookIngestorConfig,
    bufferSize?: number,
    instanceId?: string,
  ) {
    super(connectionAlias, secrets, webhookConfig, bufferSize, instanceId);

    // Board ID filter for multi-instance discrimination
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- injected by IngestorManager for multi-instance support
    this.boardId = (webhookConfig as any)._boardId as string | undefined;
  }

  /**
   * Return the board ID for lifecycle webhook registration.
   * Used by the lifecycle manager to match existing webhooks by model ID
   * and clean up stale registrations.
   */
  protected override getModelId(): string | undefined {
    return this.boardId;
  }

  /**
   * Filter webhooks by board ID for multi-instance support.
   * When boardId is set, only events from that specific board are accepted.
   * The board ID is found in `body.model.id` of Trello webhook payloads.
   */
  protected shouldAcceptPayload(body: unknown): boolean {
    if (!this.boardId) return true;
    const payload = body as { model?: { id?: string } };
    return payload.model?.id === this.boardId;
  }

  /**
   * Verify the Trello webhook signature (HMAC-SHA1, base64-encoded).
   *
   * If both `signatureHeader` and `signatureSecretName` are configured,
   * the signature is verified. If either is absent, verification is skipped.
   *
   * Trello's HMAC is computed over `${rawBody}${callbackURL}`, so the
   * `callbackUrl` must be configured for verification to work.
   */
  protected verifySignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): { valid: boolean; reason?: string } {
    if (!this.signatureSecretName || !this.signatureHeader) {
      return { valid: true };
    }

    const secret = this.secrets[this.signatureSecretName];
    if (!secret) {
      log.error(
        `Signature secret "${this.signatureSecretName}" not found ` +
          `in resolved secrets for ${this.connectionAlias}`,
      );
      return { valid: false, reason: 'Signature secret not configured' };
    }

    if (!this.resolvedCallbackUrl) {
      log.error(
        `Callback URL not configured for ${this.connectionAlias}. ` +
          `Trello signature verification requires the callbackUrl.`,
      );
      return { valid: false, reason: 'Callback URL not configured' };
    }

    // Extract the X-Trello-Webhook header (case-insensitive lookup)
    const rawHeader =
      headers[TRELLO_SIGNATURE_HEADER] ?? headers[TRELLO_SIGNATURE_HEADER.toLowerCase()];
    const signatureValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (!signatureValue) {
      return { valid: false, reason: 'Missing signature header' };
    }

    if (!verifyTrelloSignature(rawBody, signatureValue, secret, this.resolvedCallbackUrl)) {
      log.warn(`Signature verification failed for ${this.connectionAlias}`);
      return { valid: false, reason: 'Signature verification failed' };
    }

    return { valid: true };
  }

  /**
   * Extract the event type from the Trello webhook body.
   *
   * Trello encodes the action type in `body.action.type`
   * (e.g., 'updateCard', 'createCard', 'commentCard', 'addMemberToBoard').
   */
  protected extractEventType(
    _headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): string {
    return extractTrelloActionType(body);
  }

  /**
   * Extract event data in the Trello-specific shape:
   * `{ actionId, actionType, model, payload }`.
   */
  protected extractEventData(
    _headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): unknown {
    const actionType = extractTrelloActionType(body);
    const actionId = extractTrelloActionId(body);

    return {
      actionId,
      actionType,
      payload: body,
    };
  }

  /**
   * Extract the Trello action ID as the idempotency key.
   *
   * Each Trello webhook carries an action with a unique `id` field.
   * Using this as the idempotency key prevents duplicate events
   * from webhook retries.
   */
  protected extractIdempotencyKey(
    _headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): string | undefined {
    const actionId = extractTrelloActionId(body);
    return actionId ? `trello:${actionId}` : undefined;
  }
}

// ── Self-registration ───────────────────────────────────────────────────

registerIngestorFactory(
  'webhook:trello',
  (connectionAlias, config, secrets, bufferSize, instanceId) => {
    if (!config.webhook) {
      log.error(`Missing webhook config for ${connectionAlias}`);
      return null;
    }
    return new TrelloWebhookIngestor(
      connectionAlias,
      secrets,
      config.webhook,
      bufferSize,
      instanceId,
    );
  },
);
