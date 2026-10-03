/**
 * The name-only tool categorizer shared by the Cline, pi and ACP adapters.
 *
 * All three bridge a foreign tool vocabulary onto callboard's four axes from a
 * tool *name* alone, and all three used to carry their own byte-identical copy
 * of the identifier check, tokenizer and token table below. What legitimately
 * differs between them is the exact-name table, so that is the one input:
 * Cline and pi each pass their own (they disagree on purpose — see each
 * adapter's `EXACT_CATEGORIES`), ACP passes none.
 *
 * Each adapter still exports its own named categorizer built from this factory,
 * so the registry in `categorizers.ts` keeps one entry per provider and the
 * two-pass rule ("both passes run the identical function") still holds per
 * adapter.
 */
import { isComputerControlToolName } from "./computerControl.js";
import type { PermissionCategory } from "./ToolPermissionPolicy.js";

/**
 * The category anything unrecognizable resolves to.
 *
 * `codeExecution` is the top of the restrictiveness order: a tool that can run
 * code can do everything the other three axes describe, so it is the only safe
 * answer when we do not know what a tool is.
 *
 * Note what this is NOT: `null`. `decidePermission(null, …)` returns "ask"
 * *unconditionally* — it does not consult the user's settings at all — so a
 * `null` default would prompt even under an all-"allow" policy. Callboard's
 * unattended runners (job steps, deployed agents, `start_chat_session`) all
 * hardcode every axis to `"allow"` precisely so they need no human, and an agent
 * job step has no timeout: a prompt nobody answers hangs the run until it is
 * aborted.
 */
export const MOST_RESTRICTIVE_CATEGORY: PermissionCategory = "codeExecution";

/**
 * Token families for names not in an exact table, **most restrictive first**.
 * A name matching more than one family resolves to the first listed.
 *
 * The order is the polarity that matters: the original ran least-privileged
 * first on the reasoning that an ambiguous name should "never silently widen
 * its own gate", which is exactly backwards. Resolving `search_and_run` to
 * `fileRead` treats a run-capable tool as read-only — *that* is the widening,
 * and `fileRead` is the axis users most often set to `allow`.
 *
 * The order is by what a tool in that family can do, not by alphabet:
 * `codeExecution` subsumes the rest, `fileWrite` mutates local state,
 * `webAccess` moves data in and out of the machine, `fileRead` only observes.
 *
 * The fallback serves callboard's own tools, which surface under bare names
 * (`spawn_job`, `set_chat_title`) on Cline and pi, and any MCP or vendor tools —
 * none of which are knowable in advance.
 */
const CATEGORY_TOKENS: ReadonlyArray<readonly [PermissionCategory, readonly string[]]> = [
  ["codeExecution", ["bash", "sh", "shell", "exec", "execute", "run", "terminal", "command", "spawn", "eval", "script", "process", "kill"]],
  [
    "fileWrite",
    // `replace` earns its place the hard way: Cursor's `search_replace` is a
    // real editing tool, and without this token it fell through to `fileRead`.
    [
      "write",
      "edit",
      "create",
      "delete",
      "remove",
      "move",
      "rename",
      "patch",
      "apply",
      "mkdir",
      "replace",
      "insert",
      "append",
      "update",
      "modify",
      "save",
      "touch",
    ],
  ],
  ["webAccess", ["fetch", "http", "https", "web", "browse", "url", "download", "upload", "curl", "request"]],
  ["fileRead", ["read", "glob", "grep", "search", "find", "list", "cat", "view", "stat"]],
];

/**
 * Does this string look like a *tool name*, as opposed to a sentence?
 *
 * Rule 3 of the two-pass ruling. `ToolPermissionPolicy` is a
 * `(toolName: string, …)` bridge and nothing structurally guarantees the caller
 * passes an identifier — ACP's label falls back to a human-readable `title`, and
 * `` Run `rm -rf` to clear the search index `` tokenizes to `search`. Prose is
 * never parsed for a gate: anything that is not a single identifier-shaped token
 * goes straight to {@link MOST_RESTRICTIVE_CATEGORY} and its words are never read.
 *
 * Deliberately strict — no spaces, no quotes, no punctuation beyond what real
 * tool names use (`read_file`, `mcp__server__tool`, `fs.read`, `web-search`).
 */
export function isToolIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,63}$/.test(value);
}

/**
 * Build a categorizer that resolves a tool name in this order:
 *  1. a computer-control tool                   → `computerControl`
 *  2. not identifier-shaped                     → {@link MOST_RESTRICTIVE_CATEGORY}
 *  3. exact match in `exact` (if given)
 *  4. token match in {@link CATEGORY_TOKENS}, most restrictive family first
 *  5. {@link MOST_RESTRICTIVE_CATEGORY}
 *
 * Never returns `null` — see {@link MOST_RESTRICTIVE_CATEGORY} for why "ask" is
 * not a safe default on a path unattended runs depend on. The return type keeps
 * `| null` only to satisfy the shared `ToolCategorizer` signature.
 */
export function makeNameCategorizer(exact?: ReadonlyMap<string, PermissionCategory>): (toolName: string) => PermissionCategory | null {
  return (toolName) => {
    if (isComputerControlToolName(toolName)) return "computerControl";
    const trimmed = toolName.trim();
    if (!isToolIdentifier(trimmed)) return MOST_RESTRICTIVE_CATEGORY;

    const exactCategory = exact?.get(trimmed);
    if (exactCategory) return exactCategory;

    // Tokenize rather than using `\b` word boundaries: these names are
    // overwhelmingly snake_case and `_` is a word character, so `/\bread\b/`
    // does NOT match `read_file`, which would send every read tool to the
    // conservative default. Splitting on non-alphanumerics handles snake_case,
    // camelCase and kebab-case for free.
    const tokens = new Set(
      trimmed
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );

    for (const [category, words] of CATEGORY_TOKENS) {
      if (words.some((w) => tokens.has(w))) return category;
    }
    return MOST_RESTRICTIVE_CATEGORY;
  };
}
