/**
 * Trello webhook types and signature verification utilities.
 *
 * Provides pure-function signature verification for Trello webhook payloads
 * using HMAC-SHA1 with base64 encoding.
 *
 * Trello signs webhooks differently from GitHub and Stripe:
 * - The signature header is `X-Trello-Webhook` (base64-encoded HMAC-SHA1)
 * - The HMAC is computed over `${rawBody}${callbackURL}` (body + callback URL)
 * - The signing secret is the application's API secret (also the OAuth 1.0 secret)
 * - There is no timestamp-based replay protection
 *
 * @see https://developer.atlassian.com/cloud/trello/guides/rest-api/webhooks/
 */

import crypto from 'node:crypto';

// ── Trello webhook header name ──────────────────────────────────────────

/** Header containing the base64-encoded HMAC-SHA1 signature. */
export const TRELLO_SIGNATURE_HEADER = 'x-trello-webhook';

// ── Types ────────────────────────────────────────────────────────────────

/** Shape of a Trello webhook action (the `action` field in the payload). */
export interface TrelloWebhookAction {
  /** Unique action ID. */
  id: string;
  /** Action type (e.g., 'updateCard', 'createCard', 'commentCard'). */
  type: string;
  /** ISO-8601 timestamp of the action. */
  date: string;
  /** ID of the member who triggered the action. */
  idMemberCreator: string;
  /** Action-specific data (board, card, list, old values, etc.). */
  data: Record<string, unknown>;
  /** Member who triggered the action. */
  memberCreator?: {
    id: string;
    fullName: string;
    username: string;
  };
}

/** Shape of the webhook metadata included in each delivery. */
export interface TrelloWebhookInfo {
  /** Webhook ID. */
  id: string;
  /** Webhook description. */
  description: string;
  /** ID of the model being monitored. */
  idModel: string;
  /** The callback URL configured for this webhook. */
  callbackURL: string;
  /** Whether the webhook is currently active. */
  active: boolean;
  /** Number of consecutive delivery failures. */
  consecutiveFailures: number;
}

/** Full Trello webhook payload shape. */
export interface TrelloWebhookPayload {
  /** The action that triggered the webhook. */
  action: TrelloWebhookAction;
  /** The monitored model (board, card, list, etc.). */
  model: Record<string, unknown>;
  /** Webhook configuration metadata. */
  webhook: TrelloWebhookInfo;
}

// ── Signature verification ──────────────────────────────────────────────

/**
 * Verify a Trello webhook signature (HMAC-SHA1, base64-encoded).
 *
 * Trello computes the signature over `${rawBody}${callbackURL}` using
 * the application's API secret as the HMAC key. The result is base64-encoded
 * and sent in the `X-Trello-Webhook` header.
 *
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param rawBody - The raw request body as a Buffer.
 * @param signatureHeader - The value of the X-Trello-Webhook header (base64-encoded).
 * @param secret - The Trello application API secret.
 * @param callbackUrl - The callback URL exactly as provided during webhook creation.
 * @returns true if the signature is valid, false otherwise.
 */
export function verifyTrelloSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
  callbackUrl: string,
): boolean {
  // Trello signs: HMAC-SHA1(secret, body + callbackURL)
  const content = rawBody.toString('utf-8') + callbackUrl;
  const computedSig = crypto.createHmac('sha1', secret).update(content).digest('base64');

  // Timing-safe comparison on the raw base64 bytes
  try {
    const receivedBuf = Buffer.from(signatureHeader, 'base64');
    const computedBuf = Buffer.from(computedSig, 'base64');
    return (
      receivedBuf.length === computedBuf.length && crypto.timingSafeEqual(receivedBuf, computedBuf)
    );
  } catch {
    // Invalid base64 or length mismatch
    return false;
  }
}

// ── Payload extraction helpers ──────────────────────────────────────────

/**
 * Extract the action type from a parsed Trello webhook body.
 *
 * Returns `body.action.type` (e.g., 'updateCard', 'createCard',
 * 'addMemberToBoard', 'commentCard'). Falls back to 'unknown' if the
 * expected structure is missing.
 */
export function extractTrelloActionType(body: unknown): string {
  if (body && typeof body === 'object' && 'action' in body) {
    const action = (body as Record<string, unknown>).action;
    if (action && typeof action === 'object' && 'type' in action) {
      return String((action as Record<string, unknown>).type);
    }
  }
  return 'unknown';
}

/**
 * Extract the action ID from a parsed Trello webhook body.
 *
 * Returns `body.action.id` or undefined if not present.
 */
export function extractTrelloActionId(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'action' in body) {
    const action = (body as Record<string, unknown>).action;
    if (action && typeof action === 'object' && 'id' in action) {
      return String((action as Record<string, unknown>).id);
    }
  }
  return undefined;
}
