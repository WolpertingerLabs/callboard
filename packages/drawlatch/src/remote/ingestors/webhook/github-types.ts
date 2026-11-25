/**
 * GitHub webhook types and signature verification utilities.
 *
 * Provides pure-function signature verification (HMAC-SHA256 with timing-safe
 * comparison) and header extraction helpers for GitHub webhook payloads.
 *
 * @see https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */

import crypto from 'node:crypto';

// ── GitHub webhook header names ──────────────────────────────────────────

/** Header containing the event type (e.g., 'push', 'pull_request', 'issues'). */
export const GITHUB_EVENT_HEADER = 'x-github-event';

/** Header containing the HMAC-SHA256 signature: 'sha256=<hex>'. */
export const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256';

/** Header containing the unique delivery ID (UUID). */
export const GITHUB_DELIVERY_HEADER = 'x-github-delivery';

// ── Types ────────────────────────────────────────────────────────────────

/** Extracted GitHub-specific headers from an incoming webhook request. */
export interface GitHubWebhookHeaders {
  /** Event type (e.g., 'push', 'pull_request', 'issues'). Defaults to 'unknown'. */
  event: string;
  /** HMAC-SHA256 signature value from X-Hub-Signature-256 header. */
  signature?: string;
  /** Unique delivery ID from X-GitHub-Delivery header. */
  deliveryId?: string;
}

// ── Signature verification ───────────────────────────────────────────────

/**
 * Verify a GitHub webhook signature (HMAC-SHA256).
 *
 * Computes HMAC-SHA256 of the raw body using the shared secret and compares
 * it against the signature from the X-Hub-Signature-256 header using
 * timing-safe comparison to prevent timing attacks.
 *
 * @param rawBody - The raw request body as a Buffer.
 * @param signatureHeader - The value of X-Hub-Signature-256 (e.g., 'sha256=abc123...').
 * @param secret - The webhook secret configured in GitHub.
 * @returns true if the signature is valid, false otherwise.
 */
export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) return false;

  const receivedSig = signatureHeader.slice(expectedPrefix.length);
  const computedSig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  // Timing-safe comparison to prevent timing attacks.
  // Both buffers must be the same length for timingSafeEqual.
  try {
    return crypto.timingSafeEqual(Buffer.from(receivedSig, 'hex'), Buffer.from(computedSig, 'hex'));
  } catch {
    // Length mismatch or invalid hex — signature is invalid
    return false;
  }
}

// ── Header extraction ────────────────────────────────────────────────────

/**
 * Extract GitHub-specific headers from an Express request headers object.
 *
 * Returns a clean typed object with the event type, optional signature,
 * and optional delivery ID. Defaults event to 'unknown' if the header
 * is missing.
 */
export function extractGitHubHeaders(
  headers: Record<string, string | string[] | undefined>,
): GitHubWebhookHeaders {
  const getHeader = (name: string): string | undefined => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  return {
    event: getHeader(GITHUB_EVENT_HEADER) ?? 'unknown',
    signature: getHeader(GITHUB_SIGNATURE_HEADER),
    deliveryId: getHeader(GITHUB_DELIVERY_HEADER),
  };
}
