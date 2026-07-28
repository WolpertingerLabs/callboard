/**
 * The `webAccess` gate for OpenRouter's SERVER tools.
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
 * @see plans/openrouter-adapter.md:186 (where this fix was proposed)
 * @see ./permissionAdapter.ts ("What is NOT gated here")
 */
import { OR_SERVER_TOOLS, OR_SERVER_TOOL_BY_TYPE } from "shared/types/index.js";
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
  const webAccess: PermissionLevel | undefined = permissions?.webAccess;
  if (webAccess === "allow") {
    // Permitted: hand back exactly what was configured, `undefined` included,
    // so the harness's own defaults stay in force and this path is byte-for-byte
    // what shipped before the gate existed.
    return { serverTools: configured ? [...configured] : undefined, withheld: [] };
  }

  // Restrictive ("ask", "deny", or no policy at all). The default path has to be
  // materialized to be filtered — `undefined` cannot express "defaults minus
  // web_search".
  const base = configured ?? ASSUMED_HARNESS_DEFAULTS;
  const serverTools: ServerToolWire[] = [];
  const withheld: string[] = [];
  for (const tool of base) {
    if (serverToolNeedsWebAccess(tool.type)) withheld.push(tool.type);
    else serverTools.push({ ...tool });
  }
  return { serverTools, withheld };
}
