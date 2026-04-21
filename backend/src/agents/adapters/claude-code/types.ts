/**
 * Claude Code adapter — re-exports of SDK types used by callers.
 *
 * Phase 1 consolidation: callers import hook/permission types from here instead of
 * `@anthropic-ai/claude-agent-sdk` directly, so the SDK dependency is contained to
 * the adapter directory. Phase 3 replaces these with neutral port types.
 */
export type {
  PermissionResult,
  HookEvent,
  HookCallbackMatcher,
  HookCallback,
  HookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
