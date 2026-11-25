// ── Shared infrastructure ────────────────────────────────────────────────
export {
  type IngestorConfig,
  type WebSocketIngestorConfig,
  type WebhookIngestorConfig,
  type PollIngestorConfig,
  type IngestedEvent,
  type IngestorState,
  type IngestorStatus,
  DEFAULT_BUFFER_SIZE,
  MAX_BUFFER_SIZE,
} from './types.js';

export { RingBuffer } from './ring-buffer.js';
export { BaseIngestor } from './base-ingestor.js';
export { IngestorManager } from './manager.js';
export { registerIngestorFactory, createIngestor } from './registry.js';

// ── Providers (each self-registers on import) ────────────────────────────
export {
  DiscordGatewayIngestor,
  DiscordIntents,
  ALL_INTENTS,
  ALL_NON_PRIVILEGED_INTENTS,
} from './discord/index.js';

export { SlackSocketModeIngestor } from './slack/index.js';

// ── Webhook providers ────────────────────────────────────────────────────
export { WebhookIngestor } from './webhook/index.js';
export { GitHubWebhookIngestor } from './webhook/index.js';
export {
  verifyGitHubSignature,
  extractGitHubHeaders,
  type GitHubWebhookHeaders,
} from './webhook/index.js';

export { StripeWebhookIngestor } from './webhook/index.js';
export {
  verifyStripeSignature,
  parseStripeSignatureHeader,
  type StripeSignatureComponents,
  STRIPE_SIGNATURE_HEADER,
  DEFAULT_TIMESTAMP_TOLERANCE,
} from './webhook/index.js';

export { TrelloWebhookIngestor } from './webhook/index.js';
export {
  verifyTrelloSignature,
  extractTrelloActionType,
  extractTrelloActionId,
  type TrelloWebhookPayload,
  type TrelloWebhookAction,
  type TrelloWebhookInfo,
  TRELLO_SIGNATURE_HEADER,
} from './webhook/index.js';

// ── Poll provider ──────────────────────────────────────────────────────
export { PollIngestor } from './poll/index.js';
