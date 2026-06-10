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
 * also includes adapters not exposed to end users (`codex`, `mock`).
 */
export type UiAgentProviderKind = "claude-code" | "openrouter";

/**
 * OpenRouter reasoning-effort levels. Maps onto the OR `reasoning.effort`
 * field which OR translates to each provider's native parameter (Anthropic
 * `thinking.budget_tokens`, OpenAI `reasoning_effort`, Gemini
 * `thinkingConfig.thinkingLevel`, Qwen `thinking_budget`, xAI
 * `reasoning_effort`). Non-reasoning models silently ignore it.
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
  /** OR slug, e.g. "anthropic/claude-opus-4.7". Empty string = use global default. */
  model?: string;
  /** OR-only. Ignored when provider is "claude-code". */
  effort?: EffortLevel;
}
