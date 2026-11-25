/**
 * Stripe Webhook ingestor.
 *
 * A concrete webhook ingestor that handles Stripe webhook events with
 * HMAC-SHA256 signature verification and timestamp-based replay protection.
 *
 * Extends the generic `WebhookIngestor` base class, implementing Stripe-specific
 * signature verification (via `Stripe-Signature` header), event type extraction
 * (from JSON body `type` field), and data shaping.
 *
 * @see https://docs.stripe.com/webhooks
 */

import { registerIngestorFactory } from '../registry.js';
import { WebhookIngestor } from './base-webhook-ingestor.js';
import { verifyStripeSignature, STRIPE_SIGNATURE_HEADER } from './stripe-types.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('webhook');

// ── Stripe Webhook Ingestor ──────────────────────────────────────────────

export class StripeWebhookIngestor extends WebhookIngestor {
  /**
   * Verify the Stripe webhook signature.
   *
   * If both `signatureHeader` and `signatureSecretName` are configured,
   * the signature is verified using Stripe's `t=<timestamp>,v1=<sig>` scheme.
   * If either is absent, verification is skipped.
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

    // Extract the Stripe-Signature header value
    const rawHeader =
      headers[STRIPE_SIGNATURE_HEADER] ?? headers[STRIPE_SIGNATURE_HEADER.toLowerCase()];
    const signatureValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (!signatureValue) {
      return { valid: false, reason: 'Missing signature header' };
    }

    return verifyStripeSignature(rawBody, signatureValue, secret);
  }

  /**
   * Extract the event type from the Stripe event JSON body.
   *
   * Stripe encodes the event type in the body's `type` field
   * (e.g., 'payment_intent.succeeded', 'invoice.paid').
   */
  protected extractEventType(
    _headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): string {
    if (body && typeof body === 'object' && 'type' in body) {
      return String((body as Record<string, unknown>).type);
    }
    return 'unknown';
  }

  /**
   * Extract event data in the Stripe-specific shape:
   * `{ eventId, type, payload }`.
   */
  protected extractEventData(
    _headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): unknown {
    const record = body as Record<string, unknown> | undefined;
    return {
      eventId: record?.id ?? undefined,
      type: record?.type ?? 'unknown',
      payload: body,
    };
  }

  /**
   * Extract the Stripe event ID as the idempotency key.
   *
   * Each Stripe event carries a unique `id` field (e.g., 'evt_1234...').
   * Using this as the idempotency key prevents duplicate events
   * from webhook retries.
   */
  protected extractIdempotencyKey(
    _headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): string | undefined {
    const record = body as Record<string, unknown> | undefined;
    const eventId = record?.id;
    return typeof eventId === 'string' ? `stripe:${eventId}` : undefined;
  }
}

// ── Self-registration ────────────────────────────────────────────────────

registerIngestorFactory(
  'webhook:stripe',
  (connectionAlias, config, secrets, bufferSize, instanceId) => {
    if (!config.webhook) {
      log.error(`Missing webhook config for ${connectionAlias}`);
      return null;
    }
    return new StripeWebhookIngestor(
      connectionAlias,
      secrets,
      config.webhook,
      bufferSize,
      instanceId,
    );
  },
);
