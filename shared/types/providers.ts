/**
 * Provider-agnostic run-configuration types shared by backend and frontend.
 *
 * Lives in `shared/types/` so the OR adapter, the chat metadata layer, the
 * cron-scheduler dispatch path, and the UI pickers all reference the same
 * unions. Prior to this file these types were redeclared in
 * `backend/.../optionsAdapter.ts` and `frontend/.../localStorage.ts`; keeping
 * one definition prevents drift when OR adds a new effort level.
 */

/**
 * Provider kinds the UI is allowed to surface. The full backend
 * `AgentProviderKind` union (in `backend/src/agents/ports/AgentProvider.ts`)
 * also includes adapters not exposed to end users (`mock`). Mirrors
 * `ROUTABLE_PROVIDER_KINDS`.
 */
export type UiAgentProviderKind = "claude-code" | "codex" | "acp" | "cline" | "pi";

/**
 * Reasoning-effort levels. Named for OpenRouter's `reasoning.effort` field,
 * where they originated, and reused by every reasoning-capable harness — each
 * adapter translates them onto its own knob (Codex `modelReasoningEffort`,
 * Cline `thinking`/`reasoningEffort`, pi `thinkingLevel`). Non-reasoning models
 * silently ignore it.
 *
 * `undefined` (no value persisted) means "don't send a reasoning payload";
 * `"none"` means "explicitly request no reasoning". Both produce the same
 * runtime behavior on most models but are kept distinct for UI clarity.
 */
export type EffortLevel = "xhigh" | "high" | "medium" | "low" | "minimal" | "none";

/**
 * The per-run knobs that travel together: provider + (if OR) model + effort.
 * Used as an optional shape on chat metadata, on `CronAction`, and as the
 * payload contract for the `/message` mid-chat-update endpoint.
 *
 * All fields optional — a partial update is allowed (e.g. change model
 * without touching effort).
 */
export interface ProviderRunConfig {
  provider?: UiAgentProviderKind;
  /**
   * Which ACP vendor runs the chat — `"opencode"`, … Meaningful only
   * when `provider` is `"acp"`, and required there: `"acp"` is one kind covering
   * many CLIs, so the kind alone does not identify a harness.
   *
   * Optional on this type because every other provider ignores it, not because
   * it is optional for ACP. `POST /api/stream` rejects `provider: "acp"` without
   * a valid one rather than falling back, so a chat can never be persisted with
   * a kind and no vendor.
   */
  acpProviderId?: string;
  /**
   * Model for the chat's provider. For "claude-code": an Anthropic model alias
   * ("opus", "sonnet", "haiku", "opusplan") or full model ID (e.g.
   * "claude-sonnet-4-6"). For every other kind: that harness's own model id.
   * A cross-harness alias (see `modelAlias.ts`) works with any of them. Empty
   * string = use the provider's global default (Settings → API).
   */
  model?: string;
  /** Reasoning-capable providers only. Ignored when provider is "claude-code". */
  effort?: EffortLevel;
}
