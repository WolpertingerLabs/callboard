/**
 * Shared types for connection testing, ingestor testing, and listener
 * configuration schemas.
 *
 * These types are used in connection templates (JSON), the Route interface,
 * ResolvedRoute, and the tool handlers that expose testing and configuration
 * functionality to MCP clients.
 */

// ── Test Connection ─────────────────────────────────────────────────────

/**
 * Pre-configured test request for verifying connection credentials.
 * Must be a non-destructive, read-only endpoint with zero side effects.
 * Stored in connection templates and carried through to ResolvedRoute.
 */
export interface TestConnectionConfig {
  /** HTTP method (default: 'GET'). Should always be non-destructive. */
  method?: string;
  /** URL to test against. May contain ${VAR} placeholders. */
  url: string;
  /** Optional headers beyond the route's auto-injected headers.
   *  Values may contain ${VAR} placeholders. */
  headers?: Record<string, string>;
  /** Optional request body (for APIs that require POST for reads, e.g., GraphQL). */
  body?: unknown;
  /** Human-readable description of what this test does (e.g., "Fetches authenticated user"). */
  description?: string;
  /** Expected HTTP status code(s) that indicate success. Default: [200] */
  expectedStatus?: number[];
}

// ── Test Ingestor / Event Listener ──────────────────────────────────────

/**
 * Pre-configured test for verifying event listener / ingestor configuration.
 *
 * The semantics vary by strategy:
 *   - 'websocket_auth' — Hit an API endpoint that verifies the token is valid for gateway access
 *   - 'webhook_verify' — Verify that required webhook secrets are configured
 *   - 'poll_once'      — Execute a single poll request and verify the response shape
 *   - 'http_request'   — Execute a custom HTTP request to verify listener setup
 *
 * Set to null in a connection template to explicitly indicate that the
 * listener cannot be independently tested.
 */
export interface TestIngestorConfig {
  /** Human-readable description of what this test verifies. */
  description: string;
  /** Strategy for testing. */
  strategy: 'websocket_auth' | 'webhook_verify' | 'poll_once' | 'http_request';
  /** For 'http_request' or 'websocket_auth': the HTTP request to execute. */
  request?: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    expectedStatus?: number[];
  };
  /** For 'webhook_verify': secret names that must be present and non-empty. */
  requireSecrets?: string[];
}

// ── Listener Configuration Schema ───────────────────────────────────────

/**
 * A single configurable field for an event listener.
 * Provides enough metadata for any UI (web dashboard, CLI, AI agent)
 * to dynamically render the right input control.
 */
export interface ListenerConfigField {
  /** Machine-readable key (e.g., "boardId", "eventFilter", "guildIds"). */
  key: string;

  /** Human-readable label for display (e.g., "Trello Board ID"). */
  label: string;

  /** Help text / description shown below the field. */
  description?: string;

  /** Whether this field must be provided before the listener can start. Default: false */
  required?: boolean;

  /**
   * The field type — determines how UIs should render this.
   *   - 'text'        — single text input
   *   - 'number'      — numeric input (respects min/max)
   *   - 'boolean'     — toggle / checkbox
   *   - 'select'      — single-choice dropdown (uses options)
   *   - 'multiselect' — multi-choice checklist (uses options)
   *   - 'secret'      — masked text input (for sensitive values)
   *   - 'text[]'      — list of text values (e.g., guild IDs, channel IDs)
   */
  type: 'text' | 'number' | 'boolean' | 'select' | 'multiselect' | 'secret' | 'text[]';

  /** Default value if not set by the user. */
  default?: string | number | boolean | string[];

  /** For 'select' and 'multiselect': the available options. */
  options?: ListenerConfigOption[];

  /** For 'text': placeholder text. */
  placeholder?: string;

  /** For 'number': minimum allowed value. */
  min?: number;

  /** For 'number': maximum allowed value. */
  max?: number;

  /** For 'text': regex pattern for validation. */
  pattern?: string;

  /**
   * For dynamic options that must be fetched from the API at configure-time.
   * A UI calls `resolve_listener_options` with the connection alias and
   * this param key, and the server executes this request to populate options.
   */
  dynamicOptions?: {
    /** URL to fetch options from. ${VAR} placeholders resolved. */
    url: string;
    /** HTTP method (default: 'GET'). */
    method?: string;
    /** Request body (for POST requests). */
    body?: unknown;
    /** Dot-path to the array in the response. Omit if top-level array. */
    responsePath?: string;
    /** Field in each item to use as the display label. */
    labelField: string;
    /** Field in each item to use as the value. */
    valueField: string;
  };

  /**
   * Which IngestorOverrides key this maps to for automatic merging.
   * If omitted, the field's `key` is used directly as the override key.
   */
  overrideKey?: string;

  /**
   * Marks this field as the instance-identifying key for multi-instance support.
   * When true, each unique value of this field creates a separate listener instance
   * (e.g., boardId for Trello, subreddit for Reddit).
   * At most one field per listenerConfig should have instanceKey: true.
   */
  instanceKey?: boolean;

  /** Group label for organizing fields in UIs (e.g., "Filtering", "Connection", "Advanced"). */
  group?: string;
}

/** An option for select/multiselect fields. */
export interface ListenerConfigOption {
  /** Machine-readable value. */
  value: string | number | boolean;
  /** Human-readable label. */
  label: string;
  /** Optional description for this option. */
  description?: string;
}

/**
 * Complete listener configuration schema for a connection.
 * Stored in connection templates alongside the `ingestor` config.
 */
export interface ListenerConfigSchema {
  /** Human-readable name (e.g., "Discord Gateway Listener"). */
  name: string;
  /** Description of what this listener does. */
  description?: string;
  /** The configurable fields. */
  fields: ListenerConfigField[];
  /**
   * Whether this listener supports multiple concurrent instances.
   * When true, callers can define `listenerInstances` in their config to spawn
   * N ingestors per connection with different parameter values (e.g., watching
   * multiple Trello boards or multiple Reddit subreddits simultaneously).
   * Default: false
   */
  supportsMultiInstance?: boolean;
}
