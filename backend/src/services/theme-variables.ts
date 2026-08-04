/**
 * The variables a stored theme may define.
 *
 * Kept apart from `quick-completion.ts` so that anything wanting the list — the
 * contrast tests, a future editor UI — can have it without dragging in the agent
 * SDK behind theme generation.
 */
/**
 * Every variable a theme is allowed to define — which is exactly every variable
 * `frontend/src/index.css` defines with a *literal* value.
 *
 * The stylesheet has two kinds of variable and the split is not stylistic:
 *
 * - **Primitives** hold a literal colour or shadow (`--accent: #705ce0`). A
 *   theme is the act of choosing these, so all of them belong here.
 * - **Derived** variables hold `var()` or `color-mix()` referring to primitives
 *   (`--chatlist-badge-triggered-bg: color-mix(in srgb, var(--status-triggered)
 *   15%, transparent)`). They exist *so that* a theme reaches the chat-list and
 *   board layers without naming them. Listing one here would let a theme pin it
 *   to a flat value and cut the very cascade it was built for.
 *
 * Two literal-but-colourless entries (`--chatlist-header-bg`, `--chatlist-item-bg`,
 * both `transparent`) are excluded: there is no colour to choose. So are the
 * non-visual tokens `--font-mono`, `--radius` and `--safe-bottom`, which are
 * typography and geometry rather than palette.
 *
 * The list was never *wrong* — every name on it satisfies that rule. It was
 * simply frozen: `--bg-sidebar`, `--bg-popout`, `--info-bg`, `--status-green`
 * and `--badge-provider-codex-bg` were added to the stylesheet afterwards and
 * never added here, so a stored theme would override half of a feature's colours
 * and inherit the other half. `quick-completion.themeVariables.test.ts` parses
 * index.css and fails if the two ever drift again, which is the only thing that
 * makes "complete" a durable claim rather than a moment.
 */
export const THEME_VARIABLE_NAMES = [
  "bg",
  "bg-sidebar",
  "bg-popout",
  "surface",
  "border",
  "text",
  "text-muted",
  "accent",
  "accent-hover",
  "user-bg",
  "assistant-bg",
  "code-bg",
  "danger",
  "error",
  "success",
  "warning",
  "bg-secondary",
  "text-secondary",
  "border-light",
  "text-on-accent",
  "text-on-danger",
  "accent-bg",
  "accent-light",
  "danger-bg",
  "danger-border",
  "warning-bg",
  "success-bg",
  "info-bg",
  "overlay-bg",
  "shadow-sm",
  "shadow-md",
  "shadow-lg",
  "diff-added-bg",
  "diff-added-border",
  "diff-added-text",
  "diff-added-line-bg",
  "diff-removed-bg",
  "diff-removed-border",
  "diff-removed-text",
  "diff-removed-line-bg",
  "diff-hunk-bg",
  "toggle-knob",
  "status-active",
  "status-triggered",
  "status-green",
  "badge-info",
  "badge-info-bg",
  "badge-trigger",
  "badge-worktree",
  "badge-provider-codex-bg",
  "badge-provider-acp-bg",
  "badge-provider-cline-bg",
  "badge-provider-pi-bg",
  "badge-env-text",
  "badge-env-bg",
  "badge-env-border",
  "badge-sse-text",
  "badge-sse-bg",
  "builtin-user-bg",
  "builtin-user-border",
  "builtin-assistant-bg",
  "builtin-assistant-border",
  "builtin-text",
];
