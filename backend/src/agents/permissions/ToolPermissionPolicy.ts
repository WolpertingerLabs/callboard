/**
 * Provider-neutral permission policy.
 *
 * The category → allow/deny/ask decision is identical across engines; only
 * the tool-name → category mapping is adapter-specific (tool names differ
 * between Claude Code, Codex, pi, etc.). Adapters inject their own
 * categorizer via the constructor.
 *
 * @see plans/agent-abstraction-layer.md (Decision 2)
 */
import type { DefaultPermissions } from "shared/types/index.js";

export type PermissionCategory = keyof DefaultPermissions;
export type PermissionDecision = "allow" | "deny" | "ask";

/** The axes that gate the managed `cu_*` transport. Categorizers only ever emit `computerControl`. */
const CONTROL_AXES = ["browserControl", "computerControl", "sandboxControl"] as const;

/**
 * Pure function: given a category (or null) and the user's default-permission
 * settings, return the decision. Unknown tools / missing built-in settings ask.
 * Managed computer control delegates scoped approval to the authoritative service.
 */
export function decidePermission(category: PermissionCategory | null, defaultPermissions: DefaultPermissions | null): PermissionDecision {
  if (!category) return "ask";
  if ((CONTROL_AXES as readonly string[]).includes(category)) {
    // The same `cu_*` tools drive both targets, and which target a call reaches
    // is decided by the session or grant, not the tool name — so this gate can
    // only decide whether the transport call reaches the service. It denies only
    // when Browser Use, Computer Use AND Sandbox desktop are all denied; otherwise the service
    // (`computerUseScopeError` + the per-target level) enforces per target.
    //
    // Scoped approval is owned by the managed service, which sees the principal.
    // Generic harness prompts cannot approve scope and would duplicate its ask,
    // so an explicit "ask" admits the transport call; this grants no authority.
    // An ABSENT axis is not "ask": legacy records and chats with no permissions
    // at all predate the axis and never opted in. The normalizer maps absence
    // to deny (shared/types/permissions.ts); this is the same rule for callers
    // that hand over raw metadata.
    const open = CONTROL_AXES.some((axis) => {
      const level = defaultPermissions?.[axis];
      return level === "allow" || level === "ask";
    });
    return open ? "allow" : "deny";
  }
  const policy = defaultPermissions?.[category];
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
