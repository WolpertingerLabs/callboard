// ── Generic base class ──────────────────────────────────────────────────
export { WebhookIngestor } from './base-webhook-ingestor.js';

// ── GitHub provider ─────────────────────────────────────────────────────
export { GitHubWebhookIngestor } from './github-webhook-ingestor.js';
export {
  verifyGitHubSignature,
  extractGitHubHeaders,
  type GitHubWebhookHeaders,
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  GITHUB_DELIVERY_HEADER,
} from './github-types.js';

// ── Stripe provider ─────────────────────────────────────────────────────
export { StripeWebhookIngestor } from './stripe-webhook-ingestor.js';
export {
  verifyStripeSignature,
  parseStripeSignatureHeader,
  type StripeSignatureComponents,
  STRIPE_SIGNATURE_HEADER,
  DEFAULT_TIMESTAMP_TOLERANCE,
} from './stripe-types.js';

// ── Trello provider ─────────────────────────────────────────────────────
export { TrelloWebhookIngestor } from './trello-webhook-ingestor.js';
export {
  verifyTrelloSignature,
  extractTrelloActionType,
  extractTrelloActionId,
  type TrelloWebhookPayload,
  type TrelloWebhookAction,
  type TrelloWebhookInfo,
  TRELLO_SIGNATURE_HEADER,
} from './trello-types.js';
