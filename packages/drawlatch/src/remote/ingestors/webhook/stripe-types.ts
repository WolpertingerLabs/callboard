/**
 * Stripe webhook types and signature verification utilities.
 *
 * Provides pure-function signature verification for Stripe webhook payloads,
 * including HMAC-SHA256 verification with timestamp-based replay protection.
 *
 * Stripe signs webhooks differently from GitHub:
 * - The signature header (`Stripe-Signature`) contains a timestamp `t` and
 *   one or more `v1` signatures in the format: `t=<unix>,v1=<hex>,v1=<hex>`
 * - The HMAC is computed over `${timestamp}.${rawBody}` (not the raw body alone)
 * - Replay protection rejects events older than a configurable tolerance (default 5 min)
 *
 * @see https://docs.stripe.com/webhooks/signatures
 */

import crypto from 'node:crypto';

// ── Stripe webhook header name ──────────────────────────────────────────

/** Header containing the Stripe webhook signature. */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

// ── Constants ───────────────────────────────────────────────────────────

/** Default timestamp tolerance for replay protection (300 seconds = 5 minutes). */
export const DEFAULT_TIMESTAMP_TOLERANCE = 300;

// ── Types ────────────────────────────────────────────────────────────────

/** Parsed components from a Stripe-Signature header. */
export interface StripeSignatureComponents {
  /** Unix timestamp (seconds) when Stripe generated the signature. */
  timestamp: number;
  /** One or more HMAC-SHA256 hex signatures (v1 scheme). */
  signatures: string[];
}

// ── Header parsing ──────────────────────────────────────────────────────

/**
 * Parse a Stripe-Signature header into its components.
 *
 * Format: `t=<unix_timestamp>,v1=<sig1>,v1=<sig2>,...`
 *
 * @param header - The raw Stripe-Signature header value.
 * @returns The parsed timestamp and signature(s), or `null` if the header is malformed.
 */
export function parseStripeSignatureHeader(header: string): StripeSignatureComponents | null {
  let timestamp: number | undefined;
  const signatures: string[] = [];

  const parts = header.split(',');
  for (const part of parts) {
    const [key, value] = part.split('=', 2);
    if (!key || !value) continue;

    const trimmedKey = key.trim();
    const trimmedValue = value.trim();

    if (trimmedKey === 't') {
      const parsed = Number(trimmedValue);
      if (Number.isNaN(parsed)) return null;
      timestamp = parsed;
    } else if (trimmedKey === 'v1') {
      signatures.push(trimmedValue);
    }
  }

  if (timestamp === undefined || signatures.length === 0) {
    return null;
  }

  return { timestamp, signatures };
}

// ── Signature verification ──────────────────────────────────────────────

/**
 * Verify a Stripe webhook signature.
 *
 * Computes HMAC-SHA256 of `${timestamp}.${rawBody}` using the webhook signing
 * secret and compares against each `v1` signature from the header using
 * timing-safe comparison.
 *
 * Also performs replay protection by checking that the timestamp is within
 * the allowed tolerance window.
 *
 * @param rawBody - The raw request body as a Buffer.
 * @param signatureHeader - The value of the Stripe-Signature header.
 * @param secret - The webhook signing secret (e.g., `whsec_...`).
 * @param tolerance - Maximum age of the event in seconds (default: 300 = 5 minutes).
 *                    Pass 0 to disable timestamp checking.
 * @returns An object with `valid: true` if the signature and timestamp are valid,
 *          or `valid: false` with a `reason` string if verification failed.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
  tolerance: number = DEFAULT_TIMESTAMP_TOLERANCE,
): { valid: boolean; reason?: string } {
  // 1. Parse the signature header
  const parsed = parseStripeSignatureHeader(signatureHeader);
  if (!parsed) {
    return { valid: false, reason: 'Malformed Stripe-Signature header' };
  }

  const { timestamp, signatures } = parsed;

  // 2. Check timestamp tolerance (replay protection)
  if (tolerance > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > tolerance) {
      return { valid: false, reason: 'Timestamp outside tolerance window' };
    }
  }

  // 3. Compute expected signature: HMAC-SHA256(secret, "${timestamp}.${rawBody}")
  const signedPayload = `${timestamp}.${rawBody.toString('utf-8')}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  // 4. Compare against each v1 signature (accept if ANY match)
  const expectedBuf = Buffer.from(expectedSig, 'hex');

  for (const sig of signatures) {
    try {
      const sigBuf = Buffer.from(sig, 'hex');
      if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return { valid: true };
      }
    } catch {
      // Invalid hex or length mismatch — try next signature
      continue;
    }
  }

  return { valid: false, reason: 'Signature verification failed' };
}
