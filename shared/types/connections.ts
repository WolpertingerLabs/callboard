/** Connection template enriched with runtime status for the UI. */
export interface ConnectionStatus {
  /** Template alias / filename (e.g., "github", "slack"). */
  alias: string;
  /** Human-readable name (e.g., "GitHub API"). */
  name: string;
  /** Short description of the connection's purpose. */
  description?: string;
  /** Link to API documentation. */
  docsUrl?: string;
  /** URL to an OpenAPI / Swagger spec. */
  openApiUrl?: string;
  /** Secret names that must always be configured (referenced in route headers). */
  requiredSecrets: string[];
  /** Secret names used by ingestors, URL placeholders, etc. (not in headers). */
  optionalSecrets: string[];
  /** Whether this connection has an ingestor for real-time events. */
  hasIngestor: boolean;
  /** Ingestor type, when present. */
  ingestorType?: "websocket" | "webhook" | "poll";
  /** Allowlisted URL patterns (glob). */
  allowedEndpoints: string[];
  /** Whether this connection is in the caller's connections list. */
  enabled: boolean;
  /** Which required secrets have values set (key name -> true/false). */
  requiredSecretsSet: Record<string, boolean>;
  /** Which optional secrets have values set (key name -> true/false). */
  optionalSecretsSet: Record<string, boolean>;
}
