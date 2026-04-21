/**
 * Provider-neutral permission policy.
 *
 * The category → allow/deny/ask decision is identical across engines; only
 * the tool-name → category mapping is adapter-specific (tool names differ
 * between Claude Code, Codex, OpenCode, etc.). Adapters inject their own
 * categorizer via the constructor.
 *
 * @see plans/agent-abstraction-layer.md (Decision 2)
 */
import type { DefaultPermissions } from "shared/types/index.js";

export type PermissionCategory = keyof DefaultPermissions;
export type PermissionDecision = "allow" | "deny" | "ask";

/**
 * Pure function: given a category (or null) and the user's default-permission
 * settings, return the decision. `null` / missing settings collapse to "ask"
 * so the caller prompts the user.
 */
export function decidePermission(category: PermissionCategory | null, defaultPermissions: DefaultPermissions | null): PermissionDecision {
  if (!category || !defaultPermissions) return "ask";
  const policy = defaultPermissions[category];
  if (policy === "allow") return "allow";
  if (policy === "deny") return "deny";
  return "ask";
}

/**
 * Bound policy that holds a live `getDefaultPermissions` accessor (so mid-session
 * policy changes in storage are picked up immediately) and delegates to a
 * provider-supplied tool-name → category categorizer.
 */
export class ToolPermissionPolicy {
  constructor(
    private readonly categorize: (toolName: string) => PermissionCategory | null,
    private readonly getDefaultPermissions: () => DefaultPermissions | null,
  ) {}

  /** Get the category the adapter would assign to this tool name. */
  categoryFor(toolName: string): PermissionCategory | null {
    return this.categorize(toolName);
  }

  /** Final decision for a given tool name. */
  decide(toolName: string): { decision: PermissionDecision; category: PermissionCategory | null } {
    const category = this.categorize(toolName);
    const decision = decidePermission(category, this.getDefaultPermissions());
    return { decision, category };
  }
}
