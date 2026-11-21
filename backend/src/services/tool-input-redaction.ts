/**
 * Redaction of tool inputs that leave the calling agent's own context.
 *
 * A permission "ask" can send a tool call's input past the agent that made
 * it: to the model safety reviewer (permission-review.ts), to drawlatch's
 * append-only audit log (permission-review-audit.ts, via `ingest_logs`), and
 * to a parent agent's `list_pending_requests` (parent-answers.ts). For most
 * tools that is the point — the reviewer judges the input. For the drawlatch
 * vault tools that write secrets (`vault_create`, `vault_update`) the input's
 * `values` map *is* the secret, and none of those sinks need it to decide.
 *
 * {@link redactToolInputForReview} replaces each value with
 * {@link REDACTED} and keeps the field names, which is what a reviewer or a
 * parent actually needs ("this stores a `value` and a `username`"). It never
 * touches what the tool itself runs with: callers pass the redacted copy to a
 * sink and keep the original for the call (`PendingRequest.input` is what an
 * approval resolves with, so it must stay whole).
 *
 * Matched by name — bare on pi (in-process tools have no server prefix),
 * `mcp__<server>__<name>` (normally `mcp__mcp-proxy__`) on Claude Code.
 */

/** The placeholder a redacted value is replaced with. */
export const REDACTED = "[redacted]";

/** The proxy tools whose `values` input holds secret values. */
const SECRET_VALUES_TOOLS: ReadonlySet<string> = new Set(["vault_create", "vault_update"]);

/**
 * The bare tool name: the part after `mcp__<server>__` when qualified, else
 * the name as given. Any server, not only `mcp-proxy`, so a drawlatch MCP
 * server mounted under another name is covered too.
 */
function bareToolName(toolName: string): string {
  if (!toolName.startsWith("mcp__")) return toolName;
  const cut = toolName.lastIndexOf("__");
  return cut > "mcp_".length ? toolName.slice(cut + 2) : toolName;
}

/**
 * A copy of `input` safe to send to a reviewer, an audit log or another agent.
 * Returns `input` itself when there is nothing to redact.
 */
export function redactToolInputForReview<T extends Record<string, unknown>>(toolName: string, input: T): T {
  if (!SECRET_VALUES_TOOLS.has(bareToolName(toolName))) return input;
  if (!input || typeof input !== "object" || !("values" in input)) return input;
  const values = input.values;
  // A malformed map is redacted whole: there are no field names worth keeping,
  // and whatever it is may still be a secret.
  if (!values || typeof values !== "object" || Array.isArray(values)) return { ...input, values: REDACTED };
  return { ...input, values: Object.fromEntries(Object.keys(values).map((key) => [key, REDACTED])) };
}
