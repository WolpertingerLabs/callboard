/**
 * The `webAccess` gate for the two OpenRouter channels `canUseTool` cannot see:
 * SERVER TOOLS (`orOpts.serverTools`) and PLUGINS (`orOpts.modelParams.plugins`).
 *
 * ## Why a separate gate exists at all
 *
 * Every other tool in callboard is gated at call time by `canUseTool`. OR's
 * server tools cannot be: they are injected into the request body by an SDK
 * hook and execute on OpenRouter's servers, returning `openrouter:*` output
 * items rather than tool calls. The harness's own agent loop is explicit —
 *
 *   > server-side tools (datetime/web_search/web_fetch) are injected via OR SDK
 *   > hooks and execute on OpenRouter's servers — they bypass this wrapper, so
 *   > canUseTool only ever sees client tools.
 *
 * So the `webAccess` entries in `permissionAdapter.ts` are unreachable by
 * construction, and #285 said so in-file when it added them. **Not sending the
 * tool is the entire enforcement mechanism.** That is what this module does.
 *
 * ## The two-sided rule
 *
 * `webAccess: "allow"` injects the web tools. `"ask"` and `"deny"` both
 * withhold them. There is deliberately no middle behavior for `"ask"`: a server
 * tool is decided once, when the request body is built, and there is no
 * per-call moment at which a prompt could be raised. Injecting on `"ask"` would
 * mean silently proceeding on exactly the axis where the user asked to be
 * consulted, so `"ask"` resolves the same way `"deny"` does.
 *
 * The gate only ever NARROWS. `openRouterServerTools` remains authoritative for
 * what the user wants; this decides what they may have. Effective set =
 * configured ∩ permitted, and no setting can re-enable something the policy
 * withholds.
 *
 * ## The `DEFAULT_SERVER_TOOLS` coupling, and why it does not bite
 *
 * `serverTools: undefined` does not mean "no server tools" — it means "harness,
 * inject your own `DEFAULT_SERVER_TOOLS`" (datetime/web_search/web_fetch).
 * There is no "defaults minus web_search" option, so stripping the web tools
 * from the DEFAULT path requires sending an explicit array, which requires
 * knowing what the default path would have contained.
 *
 * Reading the harness's own constant would be the honest way to know that, and
 * it is not available: `DEFAULT_SERVER_TOOLS` is exported from the package's
 * `tools/index.js` but NOT re-exported from its root, and the package's
 * `exports` map declares only `"."` — so a deep import fails at runtime with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. Verified against the installed 0.3.0.
 *
 * What makes the copy safe anyway is that the coupling is confined to the
 * restrictive branch, where every direction of drift fails closed:
 *
 *  - `webAccess: "allow"` passes `undefined` straight through, exactly as
 *    before. The harness injects whatever its defaults are today, including any
 *    tool added since. No copy is consulted, so no copy can be wrong.
 *  - Under `"ask"`/`"deny"` we send an explicit array built from
 *    {@link ASSUMED_HARNESS_DEFAULTS} ∩ non-web. If the harness gains a fourth
 *    default tool we do not know about, it is simply absent from our array —
 *    withheld, which is the safe direction. If the harness *drops* one we still
 *    list, we send a tool the default path would not have: only ever
 *    `openrouter:datetime`, since the web-carrying ones are filtered out before
 *    this matters.
 *
 * The one hand-maintained fact is therefore "which tools reach the web", which
 * lives with the rest of the OR catalog in `shared/types/openrouterCatalog.ts`
 * rather than being a second copy of a harness internal.
 *
 * ## The plugins channel, and how it differs
 *
 * Plugins ride an entirely different route into the same request —
 * `orOpts.modelParams.plugins` rather than `orOpts.serverTools` — so the
 * server-tool gate above never saw them, and two catalog plugins are live web
 * access: `web` (search injected into every response) and `fusion` (the same
 * web-enabled panel as the fusion server tool). Both are governed here, by the
 * same rule and the same fail-closed default; see {@link applyPluginPolicy}.
 *
 * Two asymmetries with server tools are worth knowing:
 *
 *  - **No default-injection problem.** `serverTools: undefined` means "inject
 *    your defaults"; `plugins` absent simply means no plugins. So the
 *    restrictive branch has nothing to materialize, and there is no analogue of
 *    {@link ASSUMED_HARNESS_DEFAULTS} to keep in sync.
 *  - **Plugins are strictly worse on this axis.** A server tool is *offered* to
 *    the model, which may never call it. A plugin runs once per request whether
 *    the model asked or not — OpenRouter draws that contrast itself when
 *    steering users off the `web` plugin. So an ungated web plugin searches on
 *    every turn with no model decision involved at all.
 *
 * @see plans/openrouter-adapter.md:186 (where this fix was proposed)
 * @see ./permissionAdapter.ts ("What is NOT gated here")
 */
import { OR_PLUGIN_BY_ID, OR_SERVER_TOOLS, OR_SERVER_TOOL_BY_TYPE } from "shared/types/index.js";
import type { DefaultPermissions, PermissionLevel } from "shared/types/index.js";

/**
 * A server tool in the harness's verbatim wire shape — `{ type }` or
 * `{ type, parameters }`, as `serverToolToWire` produces. Typed structurally
 * rather than importing the harness's `ServerToolConfig`, which is not exported
 * from the package root either (same `exports` map as above).
 */
export type ServerToolWire = { type: string } & Record<string, unknown>;

/**
 * Our belief about the harness's `DEFAULT_SERVER_TOOLS` — the set injected when
 * `serverTools` is left `undefined`. Derived from the catalog's `defaultOn`
 * flags rather than written out again, so the repo holds ONE statement of this
 * fact (the settings UI builds its "unowned" default row from the same flags).
 *
 * Only consulted on the restrictive branch, where being wrong fails closed —
 * see the coupling note in the module doc-comment for the full argument.
 */
export const ASSUMED_HARNESS_DEFAULTS: readonly ServerToolWire[] = OR_SERVER_TOOLS.filter(
  (t) => t.defaultOn,
).map((t) => ({ type: t.type }));

/**
 * Does this server tool put the open internet within the model's reach?
 *
 * Unknown types answer `true`. A type absent from {@link OR_SERVER_TOOLS} is one
 * OpenRouter shipped after this catalog was last updated, and an unclassified
 * tool is precisely the case where guessing "harmless" is how a gate springs a
 * leak. `validateServerTools` already rejects unknown types at the settings
 * layer, so in practice this fires for a tool the harness starts injecting by
 * default before callboard learns about it — which is the case that must fail
 * closed.
 */
export function serverToolNeedsWebAccess(type: string): boolean {
  return OR_SERVER_TOOL_BY_TYPE.get(type)?.webAccess ?? true;
}

/**
 * Does this plugin put the open internet within reach?
 *
 * Unknown ids answer `true`, for the reason {@link serverToolNeedsWebAccess}
 * gives: an id absent from the catalog's `OR_PLUGINS` is one OpenRouter shipped
 * after it was last updated, and an unclassified entry is exactly where
 * guessing "harmless" springs a leak. `validateParamProfile` rejects unknown
 * plugin ids at the settings layer, so in practice this fires for a
 * hand-edited `agent-settings.json` — which is the case that must fail closed.
 */
export function pluginNeedsWebAccess(id: string): boolean {
  return OR_PLUGIN_BY_ID.get(id)?.webAccess ?? true;
}

/**
 * Does the policy permit reaching the web?
 *
 * The single place the two-sided rule is decided, so the server-tool and plugin
 * gates cannot drift apart. Only an explicit `"allow"` permits: `"ask"`,
 * `"deny"`, and no policy at all are all restrictive. `"ask"` withholds because
 * these channels are decided once, when the request body is assembled, and
 * there is no per-call moment at which a prompt could be raised — see the
 * two-sided rule in the module doc-comment.
 */
function webAccessPermitted(permissions: DefaultPermissions | null | undefined): boolean {
  const webAccess: PermissionLevel | undefined = permissions?.webAccess;
  return webAccess === "allow";
}

/** Outcome of the gate: what to send, and what the policy took away. */
export interface ServerToolPolicyResult {
  /**
   * The value for `orOpts.serverTools`. `undefined` preserves the harness's
   * own defaults (only ever returned when the policy permits web access);
   * an array is sent verbatim, and `[]` disables server tools entirely.
   */
  serverTools: ServerToolWire[] | undefined;
  /** Types withheld by the policy, for logging. Empty when nothing was removed. */
  withheld: string[];
}

/**
 * Narrow a configured server-tool set by the `webAccess` policy.
 *
 * `configured` is the user's `openRouterServerTools` setting already in wire
 * shape, or `undefined` for "harness defaults". `permissions` is the live
 * accessor's reading; `null`/`undefined` (no policy available) is treated as
 * restrictive, matching `decidePermission`, which collapses a missing policy to
 * `"ask"`. A caller that forgets to supply permissions loses web search — a
 * visible functional gap — rather than silently reopening this hole.
 *
 * Pure and total: no I/O, no logging, safe to call from anywhere.
 */
export function applyServerToolPolicy(
  configured: readonly ServerToolWire[] | undefined,
  permissions: DefaultPermissions | null | undefined,
): ServerToolPolicyResult {
  if (webAccessPermitted(permissions)) {
    // Permitted: hand back exactly what was configured, `undefined` included,
    // so the harness's own defaults stay in force and this path is byte-for-byte
    // what shipped before the gate existed.
    return { serverTools: configured ? [...configured] : undefined, withheld: [] };
  }

  // Restrictive ("ask", "deny", or no policy at all). The default path has to be
  // materialized to be filtered — `undefined` cannot express "defaults minus
  // web_search".
  const { kept, withheld } = partitionByWebAccess(
    configured ?? ASSUMED_HARNESS_DEFAULTS,
    (tool) => tool.type,
    serverToolNeedsWebAccess,
  );
  return { serverTools: kept, withheld };
}

/**
 * One configured plugin in its wire shape — `{ id, ...camelCaseParams }`, as
 * `resolveModelParams` puts them on `modelParams.plugins`.
 */
export type PluginWire = { id: string } & Record<string, unknown>;

/** Outcome of the plugin gate: what to send, and what the policy took away. */
export interface PluginPolicyResult {
  /**
   * The value for `modelParams.plugins`. Always an array (never `undefined`) —
   * unlike `serverTools`, absence carries no "use your defaults" meaning here,
   * so an empty result simply means no plugins and the caller drops the key.
   */
  plugins: PluginWire[];
  /** Plugin ids withheld by the policy, for logging. Empty when nothing was removed. */
  withheld: string[];
}

/**
 * Narrow a configured plugin set by the `webAccess` policy.
 *
 * Same rule as {@link applyServerToolPolicy} and deliberately the same
 * machinery: `"allow"` passes the set through untouched, everything else
 * (`"ask"`, `"deny"`, no policy at all) drops every plugin that reaches the web,
 * and an unrecognized plugin id counts as reaching the web. The gate only ever
 * NARROWS — the user's configured set stays authoritative for intent, and no
 * setting can re-enable a plugin the policy withholds.
 *
 * `configured` is `modelParams.plugins` or `undefined`/`[]` when none are set;
 * unlike server tools there is no default-injection case to materialize, so
 * "nothing configured" is just an empty result.
 *
 * Pure and total: no I/O, no logging, safe to call from anywhere.
 */
export function applyPluginPolicy(
  configured: readonly PluginWire[] | undefined,
  permissions: DefaultPermissions | null | undefined,
): PluginPolicyResult {
  if (!configured || configured.length === 0) return { plugins: [], withheld: [] };
  if (webAccessPermitted(permissions)) {
    // Permitted: exactly what was configured, copied so the caller cannot
    // alias into the persisted settings object.
    return { plugins: configured.map((p) => ({ ...p })), withheld: [] };
  }
  // `String(...)` because a hand-edited settings file can put a non-string id
  // here. It will not match the catalog, so it is withheld — and the log line
  // still names something the user can find.
  const { kept, withheld } = partitionByWebAccess(configured, (p) => String(p.id), pluginNeedsWebAccess);
  return { plugins: kept, withheld };
}

/**
 * Split a configured set into what a restrictive policy may keep and what it
 * takes away. Shared by both gates so "narrow, never widen; copy, never alias;
 * unknown fails closed" is implemented once rather than twice.
 */
function partitionByWebAccess<T extends object>(
  base: readonly T[],
  keyOf: (item: T) => string,
  needsWebAccess: (key: string) => boolean,
): { kept: T[]; withheld: string[] } {
  const kept: T[] = [];
  const withheld: string[] = [];
  for (const item of base) {
    const key = keyOf(item);
    if (needsWebAccess(key)) withheld.push(key);
    else kept.push({ ...item });
  }
  return { kept, withheld };
}
