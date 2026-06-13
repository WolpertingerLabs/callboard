/**
 * OpenRouter server-tool, plugin, and generation-parameter CATALOG.
 *
 * OpenRouter exposes NO endpoint that enumerates its server tools or plugins
 * (confirmed against the plugins overview, server-tools overview, and API
 * reference as of 2026-06). Clients must maintain the list by hand — this file
 * is that hand-maintained source of truth, shared by the settings UI (form
 * generation + client validation) and the backend (server-side validation +
 * request assembly). When OpenRouter ships a new server tool / plugin / param,
 * update the arrays below.
 *
 * Docs this mirrors (re-verify here when editing):
 *  - Plugins:       https://openrouter.ai/docs/guides/features/plugins
 *  - Server tools:  https://openrouter.ai/docs/guides/features/server-tools/overview
 *  - Fusion:        https://openrouter.ai/docs/guides/features/plugins/fusion
 *  - Pareto router: https://openrouter.ai/docs/guides/routing/routers/pareto-router
 *  - API params:    https://openrouter.ai/docs/api/reference/parameters
 *
 * ── TWO WIRE CONVENTIONS (critical) ─────────────────────────────────────────
 * 1. Server tools (the `serverTools` harness option) are forwarded VERBATIM
 *    into the request `tools` array — the harness does not reshape them. So a
 *    server tool's param `key`s here are the literal WIRE keys (snake_case),
 *    and non-empty params are nested under a `parameters` object by the backend
 *    mapper: `{ type: "openrouter:web_search", parameters: { max_results: 5 } }`.
 * 2. Generation params + plugins (the `modelParams` harness option) ride
 *    `Partial<ResponsesRequest>`, which the OpenRouter SDK runs through a Zod
 *    schema that expects CAMELCASE and remaps to snake_case on the wire
 *    (`topP` → `top_p`, `minCodingScore` → `min_coding_score`). It also STRIPS
 *    any key it doesn't recognize — so a typo or snake_case key is silently
 *    dropped. That silent-drop is exactly why these param keys are a typed
 *    catalog and not a free-form JSON blob: every `key` below for plugins and
 *    sampling params is a camelCase `ResponsesRequest` field name.
 */

/** The kind of input a parameter takes — drives both the UI widget and validation. */
export type ParamFieldType = "number" | "integer" | "boolean" | "enum" | "string" | "stringList";

/**
 * One configurable parameter. `key` is the wire key in its channel's
 * convention (see the two-conventions note above). Optional bounds/options
 * drive both the rendered input and shared validation.
 */
export interface ParamFieldSpec {
  /** Wire key: snake_case for server-tool params, camelCase for plugin/sampling params. */
  key: string;
  /** Human-readable field label for the settings UI. */
  label: string;
  /** Widget + validation kind. */
  type: ParamFieldType;
  /** Inclusive numeric lower bound (number/integer). */
  min?: number;
  /** Inclusive numeric upper bound (number/integer). */
  max?: number;
  /** UI step hint (number/integer). */
  step?: number;
  /** Allowed values when `type === "enum"`. */
  options?: string[];
  /** Default applied by OpenRouter when omitted — shown as a placeholder, never auto-sent. */
  default?: unknown;
  /** One-line help text. */
  description?: string;
  /**
   * Sampling knobs OpenRouter documents as not honored by every provider/model
   * (`top_k`, `min_p`, `top_a`, `repetition_penalty`). The UI flags these and,
   * when a model's `supportedParameters` is known, grays them out if absent.
   */
  providerDependent?: boolean;
  /**
   * The model's `supported_parameters` entry (snake_case) this field maps to,
   * used to gray out knobs a selected model doesn't advertise. Omitted when
   * there's no 1:1 supported-parameter (e.g. plugin params).
   */
  supportedParamKey?: string;
  /**
   * Nest this field under the named sub-object instead of placing it at the
   * top level of the params bag. Used by `file-parser` (`pdf.engine`).
   */
  nestUnder?: string;
}

/** A server-side tool OpenRouter executes, selectable in the `tools` array via its `openrouter:*` type. */
export interface ServerToolSpec {
  /** Full wire discriminator, e.g. "openrouter:web_search". */
  type: string;
  /** Short label for the toggle row. */
  label: string;
  /** What the tool does. */
  description: string;
  /** Whether it's one of the harness's three defaults (datetime/web_search/web_fetch). */
  defaultOn: boolean;
  /** Configurable params (snake_case wire keys, nested under `parameters`). Empty = toggle only. */
  params: ParamFieldSpec[];
}

/** A plugin that runs once per request, configured via the `plugins` array inside `modelParams`. */
export interface PluginSpec {
  /** Plugin id, e.g. "fusion", "pareto-router". */
  id: string;
  /** Short label. */
  label: string;
  /** What it does. */
  description: string;
  /** Deprecated by OpenRouter (still works, but discouraged — e.g. the `web` plugin). */
  deprecated?: boolean;
  /** Hint about which model(s) the plugin is meaningful with (e.g. pareto-router ↔ openrouter/pareto-code). */
  modelHint?: string;
  /** Configurable params (camelCase `ResponsesRequest.plugins[]` keys). */
  params: ParamFieldSpec[];
}

/**
 * The eight server tools OpenRouter operates. Only web_search / web_fetch /
 * fusion expose meaningful params today; the rest are toggle-only. The first
 * three are the harness's `DEFAULT_SERVER_TOOLS` (injected when `serverTools`
 * is left unset).
 */
export const OR_SERVER_TOOLS: readonly ServerToolSpec[] = [
  {
    type: "openrouter:datetime",
    label: "Date / time",
    description: "Lets the model fetch the current date and time.",
    defaultOn: true,
    params: [],
  },
  {
    type: "openrouter:web_search",
    label: "Web search",
    description: "Lets the model search the web for current information.",
    defaultOn: true,
    params: [
      {
        key: "engine",
        label: "Engine",
        type: "enum",
        options: ["auto", "native", "exa", "firecrawl", "parallel", "perplexity"],
        default: "auto",
        description: "Search backend. 'auto' picks native when the provider supports it, else Exa.",
      },
      { key: "max_results", label: "Max results", type: "integer", min: 1, max: 25, default: 5 },
      {
        key: "search_context_size",
        label: "Context size",
        type: "enum",
        options: ["low", "medium", "high"],
        description: "How much retrieved context to fold into the prompt.",
      },
      { key: "max_characters", label: "Max characters / result", type: "integer", min: 1, max: 100000 },
      { key: "allowed_domains", label: "Allowed domains", type: "stringList" },
      { key: "excluded_domains", label: "Excluded domains", type: "stringList" },
    ],
  },
  {
    type: "openrouter:web_fetch",
    label: "Web fetch",
    description: "Lets the model fetch and extract the contents of a specific URL.",
    defaultOn: true,
    params: [{ key: "max_characters", label: "Max characters", type: "integer", min: 1, max: 100000 }],
  },
  {
    type: "openrouter:image_generation",
    label: "Image generation",
    description: "Lets the model generate images from text prompts.",
    defaultOn: false,
    params: [],
  },
  {
    type: "openrouter:apply_patch",
    label: "Apply patch",
    description: "Lets the model propose file edits as V4A diff patches.",
    defaultOn: false,
    params: [],
  },
  {
    type: "openrouter:fusion",
    label: "Fusion (server tool)",
    description: "Model-invoked panel-of-models + judge analysis. Distinct from the fusion plugin (which always runs once).",
    defaultOn: false,
    params: [
      { key: "analysis_models", label: "Analysis models", type: "stringList", description: "1–8 panel model slugs." },
      { key: "model", label: "Judge model", type: "string", description: "Defaults to the outer model." },
      { key: "max_tool_calls", label: "Max tool calls", type: "integer", min: 1, max: 16, default: 8 },
    ],
  },
  {
    type: "openrouter:advisor",
    label: "Advisor",
    description: "Lets the model consult a stronger model mid-generation.",
    defaultOn: false,
    params: [],
  },
  {
    type: "openrouter:subagent",
    label: "Subagent",
    description: "Lets the model delegate to a smaller/faster worker model.",
    defaultOn: false,
    params: [],
  },
];

/**
 * The plugins OpenRouter documents. Configured in the `plugins` array carried
 * by `modelParams` (camelCase keys). Plugin params that only matter for a
 * specific model carry a `modelHint` (e.g. pareto-router ↔ openrouter/pareto-code).
 */
export const OR_PLUGINS: readonly PluginSpec[] = [
  {
    id: "fusion",
    label: "Fusion",
    description: "Runs a panel of models in parallel, has a judge compare them, then synthesizes a final answer. Always runs once.",
    params: [
      { key: "analysisModels", label: "Analysis models", type: "stringList", description: "1–8 panel model slugs." },
      { key: "model", label: "Judge model", type: "string", description: "Defaults to the first Quality-preset model." },
      { key: "maxToolCalls", label: "Max tool calls", type: "integer", min: 1, max: 16, default: 8 },
    ],
  },
  {
    id: "pareto-router",
    label: "Pareto router",
    description: "Sets the coding-quality tier for the Pareto code router.",
    modelHint: "openrouter/pareto-code",
    params: [
      {
        key: "minCodingScore",
        label: "Min coding score",
        type: "number",
        min: 0,
        max: 1,
        step: 0.01,
        description: "0–1 (higher = stronger models). Omit for the High tier.",
      },
    ],
  },
  {
    id: "web",
    label: "Web search (plugin)",
    description: "Injects real-time web search results into the response. Deprecated in favor of the web_search server tool.",
    deprecated: true,
    params: [
      {
        key: "engine",
        label: "Engine",
        type: "enum",
        options: ["auto", "native", "exa"],
        default: "auto",
      },
      { key: "maxResults", label: "Max results", type: "integer", min: 1, max: 25, default: 5 },
      { key: "searchPrompt", label: "Search prompt", type: "string" },
      { key: "includeDomains", label: "Include domains", type: "stringList" },
      { key: "excludeDomains", label: "Exclude domains", type: "stringList" },
    ],
  },
  {
    id: "file-parser",
    label: "File parser (PDF)",
    description: "Parses uploaded PDFs with a selectable extraction engine.",
    params: [
      {
        key: "engine",
        label: "PDF engine",
        type: "enum",
        options: ["native", "mistral-ocr", "cloudflare-ai"],
        nestUnder: "pdf",
        description: "native (model file input), mistral-ocr ($2/1k pages, best for scans), or cloudflare-ai (free).",
      },
    ],
  },
  {
    id: "response-healing",
    label: "Response healing",
    description: "Automatically repairs malformed JSON responses.",
    params: [],
  },
  {
    id: "context-compression",
    label: "Context compression",
    description: "Compresses prompts that exceed the context window via middle-out truncation.",
    params: [],
  },
];

/**
 * Generation/sampling parameters accepted by OpenRouter chat completions, as
 * camelCase `ResponsesRequest` field names. `temperature`/`topP` etc. are
 * broadly supported; the `providerDependent` ones are OpenRouter extensions
 * that not all providers honor. Note: `reasoning.effort` is handled separately
 * by the harness's `effort` option (per-chat) and is intentionally NOT here.
 */
export const OR_SAMPLING_PARAMS: readonly ParamFieldSpec[] = [
  { key: "temperature", label: "Temperature", type: "number", min: 0, max: 2, step: 0.05, default: 1, supportedParamKey: "temperature" },
  { key: "topP", label: "Top P", type: "number", min: 0, max: 1, step: 0.01, default: 1, supportedParamKey: "top_p" },
  { key: "topK", label: "Top K", type: "integer", min: 0, providerDependent: true, supportedParamKey: "top_k" },
  { key: "frequencyPenalty", label: "Frequency penalty", type: "number", min: -2, max: 2, step: 0.1, default: 0, supportedParamKey: "frequency_penalty" },
  { key: "presencePenalty", label: "Presence penalty", type: "number", min: -2, max: 2, step: 0.1, default: 0, supportedParamKey: "presence_penalty" },
  { key: "repetitionPenalty", label: "Repetition penalty", type: "number", min: 0, max: 2, step: 0.05, default: 1, providerDependent: true, supportedParamKey: "repetition_penalty" },
  { key: "minP", label: "Min P", type: "number", min: 0, max: 1, step: 0.01, default: 0, providerDependent: true, supportedParamKey: "min_p" },
  { key: "topA", label: "Top A", type: "number", min: 0, max: 1, step: 0.01, default: 0, providerDependent: true, supportedParamKey: "top_a" },
  { key: "seed", label: "Seed", type: "integer", supportedParamKey: "seed" },
  { key: "maxTokens", label: "Max tokens", type: "integer", min: 1, supportedParamKey: "max_tokens" },
];

// ── Persisted config shapes (referenced by AgentSettings) ────────────────────

/**
 * One enabled server tool plus its params (snake_case wire keys). The backend
 * maps this to a harness `ServerToolConfig`: `{ type }` when `params` is empty,
 * else `{ type, parameters: params }`.
 */
export interface OpenRouterServerToolConfig {
  /** Full `openrouter:*` type, must match an `OR_SERVER_TOOLS` entry. */
  type: string;
  /** Snake_case params, validated against the tool's spec. Omitted/empty ⇒ no `parameters` object. */
  params?: Record<string, unknown>;
}

/**
 * A reusable parameter profile: camelCase sampling knobs plus an array of
 * configured plugins. Used both as the global default and as per-model
 * overrides. The backend flattens this into `modelParams` (sampling params
 * spread at top level, `plugins` carried as `modelParams.plugins`).
 */
export interface OpenRouterParamProfile {
  /** camelCase `ResponsesRequest` sampling fields (temperature, topP, …). */
  params?: Record<string, unknown>;
  /** Configured plugins: `{ id, ...camelCaseParams }`, validated against `OR_PLUGINS`. */
  plugins?: Array<{ id: string } & Record<string, unknown>>;
}

/** Fast lookup helpers shared by validators and the UI. */
export const OR_SERVER_TOOL_BY_TYPE: ReadonlyMap<string, ServerToolSpec> = new Map(
  OR_SERVER_TOOLS.map((t) => [t.type, t]),
);
export const OR_PLUGIN_BY_ID: ReadonlyMap<string, PluginSpec> = new Map(OR_PLUGINS.map((p) => [p.id, p]));
export const OR_SAMPLING_PARAM_BY_KEY: ReadonlyMap<string, ParamFieldSpec> = new Map(
  OR_SAMPLING_PARAMS.map((p) => [p.key, p]),
);

// ── Shared validation + wire-building (used by BOTH backend and frontend) ────
// Keeping this here guarantees the persisted shape, the validation rules, and
// the request-body mapping never drift between the two sides.

/** Where a raw param value sits relative to its spec (top level or nested under `nestUnder`). */
function readRaw(input: Record<string, unknown>, spec: ParamFieldSpec): unknown {
  if (spec.nestUnder) {
    const nested = input[spec.nestUnder];
    return nested && typeof nested === "object" ? (nested as Record<string, unknown>)[spec.key] : undefined;
  }
  return input[spec.key];
}

/** Place a coerced value into `out`, honoring `nestUnder`. */
function writeValue(out: Record<string, unknown>, spec: ParamFieldSpec, value: unknown): void {
  if (spec.nestUnder) {
    const nested = (out[spec.nestUnder] as Record<string, unknown>) ?? {};
    nested[spec.key] = value;
    out[spec.nestUnder] = nested;
  } else {
    out[spec.key] = value;
  }
}

/**
 * Coerce + validate one field's raw value against its spec. Returns `{ skip: true }`
 * for empty/absent values (the field simply isn't sent — unset ≠ default), a
 * coerced `value`, or an `error` string. Total and pure.
 */
function coerceField(spec: ParamFieldSpec, raw: unknown): { skip: true } | { value: unknown } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { skip: true };
  switch (spec.type) {
    case "number":
    case "integer": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) return { error: `${spec.label}: must be a number` };
      if (spec.type === "integer" && !Number.isInteger(n)) return { error: `${spec.label}: must be a whole number` };
      if (spec.min !== undefined && n < spec.min) return { error: `${spec.label}: must be ≥ ${spec.min}` };
      if (spec.max !== undefined && n > spec.max) return { error: `${spec.label}: must be ≤ ${spec.max}` };
      return { value: n };
    }
    case "boolean":
      return { value: Boolean(raw) };
    case "enum":
      if (typeof raw !== "string" || !(spec.options ?? []).includes(raw)) {
        return { error: `${spec.label}: must be one of ${(spec.options ?? []).join(", ")}` };
      }
      return { value: raw };
    case "string":
      if (typeof raw !== "string") return { error: `${spec.label}: must be a string` };
      return { value: raw };
    case "stringList": {
      const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : null;
      if (!arr) return { error: `${spec.label}: must be a list of strings` };
      const cleaned = arr.filter((s): s is string => typeof s === "string" && s.length > 0);
      return cleaned.length === 0 ? { skip: true } : { value: cleaned };
    }
    default:
      return { skip: true };
  }
}

/**
 * Validate a params bag against a field-spec list. Coerces known keys, records
 * an error for any UNKNOWN key (the silent-drop footgun — surfaced loudly
 * instead), and honors `nestUnder`. Returns the cleaned bag + any errors.
 */
export function validateParams(
  specs: readonly ParamFieldSpec[],
  input: Record<string, unknown>,
  context: string,
): { value: Record<string, unknown>; errors: string[] } {
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  const known = new Set<string>();
  for (const spec of specs) {
    known.add(spec.nestUnder ?? spec.key);
    const res = coerceField(spec, readRaw(input, spec));
    if ("error" in res) errors.push(`${context}: ${res.error}`);
    else if ("value" in res) writeValue(out, spec, res.value);
  }
  for (const key of Object.keys(input)) {
    if (!known.has(key)) errors.push(`${context}: unknown parameter "${key}"`);
  }
  return { value: out, errors };
}

/**
 * Validate the persisted server-tools list. Each entry's `type` must be a known
 * server tool; its `params` are validated against that tool's spec.
 */
export function validateServerTools(
  configs: readonly OpenRouterServerToolConfig[],
): { value: OpenRouterServerToolConfig[]; errors: string[] } {
  const value: OpenRouterServerToolConfig[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const cfg of configs) {
    const spec = OR_SERVER_TOOL_BY_TYPE.get(cfg.type);
    if (!spec) {
      errors.push(`Unknown server tool "${cfg.type}"`);
      continue;
    }
    if (seen.has(cfg.type)) continue; // de-dupe silently
    seen.add(cfg.type);
    const { value: params, errors: pErrors } = validateParams(spec.params, cfg.params ?? {}, spec.label);
    errors.push(...pErrors);
    value.push(Object.keys(params).length > 0 ? { type: cfg.type, params } : { type: cfg.type });
  }
  return { value, errors };
}

/**
 * Validate a persisted parameter profile (sampling params + plugins). Plugin
 * params are read off each plugin object (minus its `id`) and validated against
 * that plugin's spec.
 */
export function validateParamProfile(
  profile: OpenRouterParamProfile,
): { value: OpenRouterParamProfile; errors: string[] } {
  const errors: string[] = [];
  const out: OpenRouterParamProfile = {};

  if (profile.params && Object.keys(profile.params).length > 0) {
    const { value, errors: pErrors } = validateParams(OR_SAMPLING_PARAMS, profile.params, "Model params");
    errors.push(...pErrors);
    if (Object.keys(value).length > 0) out.params = value;
  }

  if (profile.plugins && profile.plugins.length > 0) {
    const plugins: Array<{ id: string } & Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const plugin of profile.plugins) {
      const spec = OR_PLUGIN_BY_ID.get(plugin.id);
      if (!spec) {
        errors.push(`Unknown plugin "${plugin.id}"`);
        continue;
      }
      if (seen.has(plugin.id)) continue;
      seen.add(plugin.id);
      const { id: _id, ...rawParams } = plugin;
      const { value: params, errors: pErrors } = validateParams(spec.params, rawParams, spec.label);
      errors.push(...pErrors);
      plugins.push({ id: plugin.id, ...params });
    }
    if (plugins.length > 0) out.plugins = plugins;
  }

  return { value: out, errors };
}

/** Map a persisted server-tool config to the harness's verbatim wire `ServerToolConfig`. */
export function serverToolToWire(cfg: OpenRouterServerToolConfig): { type: string } & Record<string, unknown> {
  return cfg.params && Object.keys(cfg.params).length > 0 ? { type: cfg.type, parameters: cfg.params } : { type: cfg.type };
}

/**
 * Merge a base profile with an override (override wins per-key for params;
 * plugins replace wholesale when the override supplies any), then flatten to a
 * `modelParams` bag: sampling params at top level + an optional `plugins` array.
 * Returns `undefined` when nothing would be sent.
 */
export function resolveModelParams(
  base: OpenRouterParamProfile | undefined,
  override: OpenRouterParamProfile | undefined,
): Record<string, unknown> | undefined {
  const params = { ...(base?.params ?? {}), ...(override?.params ?? {}) };
  const plugins = override?.plugins ?? base?.plugins;
  const out: Record<string, unknown> = { ...params };
  if (plugins && plugins.length > 0) out.plugins = plugins;
  return Object.keys(out).length > 0 ? out : undefined;
}
