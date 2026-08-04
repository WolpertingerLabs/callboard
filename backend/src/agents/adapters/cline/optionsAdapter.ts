/**
 * Options adapter: callboard run options → Cline `ClineCoreStartConfig`.
 *
 * Mirrors `adapters/codex/optionsAdapter.ts` and
 * `adapters/openrouter/optionsAdapter.ts` in role: `services/claude.ts` builds a
 * loosely-typed options bag, and exactly one module per adapter turns it into
 * that engine's config object. Everything Cline-shaped lives here so the query
 * stays about lifecycle.
 *
 * @see plans/cline-adapter.md
 * @see plans/cline-spike-findings.md (§4 — what we can and cannot set)
 */
import { getClineDefaultSystemPrompt, type AgentTool, type ClineCoreStartConfig } from "@cline/sdk";
import type { EffortLevel } from "shared/types/index.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("cline-options");

/**
 * Cline's reasoning-effort vocabulary, derived from the config rather than
 * imported.
 *
 * `@cline/core` re-exports a great deal of `@cline/shared` but not
 * `ReasoningEffort`, and importing from `@cline/shared` directly would depend on
 * npm hoisting a transitive dependency into a resolvable position — true today,
 * not guaranteed, and invisible when it breaks. Reading the type off the config
 * object callboard already imports keeps the coupling to the one package
 * `backend/package.json` names.
 */
type ClineReasoningEffort = NonNullable<ClineCoreStartConfig["reasoningEffort"]>;

/**
 * The `options.cline` sub-object `services/claude.ts` populates for a Cline
 * chat. Same shape of contract as `options.codex` and `options.openRouter`.
 */
export interface ClineRunOptions {
  /** Cline provider id — `"anthropic"`, `"openai"`, `"openai-compatible"`, … */
  providerId?: string;
  /** Model id within that provider. */
  model?: string;
  /** Provider API key. Absent means Cline falls back to its own env lookup. */
  apiKey?: string;
  /**
   * Base URL override, for a self-hosted or OpenAI-compatible endpoint.
   *
   * Not the OpenRouter route: `openrouter` is one of Cline's own provider ids
   * (verified against the installed SDK — it advertises 270 models), so it needs
   * only `providerId` and `apiKey`.
   */
  baseUrl?: string;
  /** Reasoning effort for capable models. */
  effort?: EffortLevel;
  /** Ceiling on agent loop iterations for a turn. */
  maxIterations?: number;
  /** System prompt override. Defaults to Cline's own. */
  systemPrompt?: string;
}

/** Cline's default provider when settings name none. */
export const DEFAULT_CLINE_PROVIDER_ID = "anthropic";

/**
 * Translate callboard's `EffortLevel` onto Cline's reasoning knobs.
 *
 * The two vocabularies are nearly identical — Cline's `ReasoningEffort` is
 * callboard's `EffortLevel` minus `"none"`. That one gap is the whole mapping:
 * `"none"` means "explicitly request no reasoning", which Cline spells as
 * `thinking: false` rather than as an effort level.
 *
 * `undefined` returns an empty object rather than a default, so a chat with no
 * effort recorded gets whatever the model does natively — the same "don't send a
 * reasoning payload" semantics `shared/types/providers.ts` documents.
 */
export function translateEffort(effort: EffortLevel | undefined): { thinking?: boolean; reasoningEffort?: ClineReasoningEffort } {
  if (!effort) return {};
  if (effort === "none") return { thinking: false };
  return { thinking: true, reasoningEffort: effort satisfies ClineReasoningEffort };
}

export interface BuildClineConfigInput {
  cline: ClineRunOptions;
  cwd: string;
  /**
   * The session id callboard wants Cline to use.
   *
   * `CoreSessionConfig.sessionId` is documented as becoming "the host-owned id
   * for persistence, hub subscriptions, send/abort/stop commands, and approval
   * routing" — so supplying it means callboard's chat id, Cline's session id and
   * the transcript filename are one value, with no translation table to keep
   * consistent.
   */
  sessionId: string;
  /** Callboard's own tools, already translated by `toolAdapter`. */
  extraTools: AgentTool[];
}

/**
 * Build the config for one `ClineCore.start()`.
 *
 * Three flags are set explicitly rather than left to their defaults, and each is
 * a deliberate refusal rather than a preference:
 *
 * - **`yolo: false`.** It is Cline's permission bypass. Nothing in callboard
 *   should ever set it true, and writing it out means a future reader sees the
 *   decision instead of an absence.
 * - **`enableAgentTeams: false`.** Teams add eighteen `team_*` tools whose
 *   coordination model overlaps callboard's own jobs and subagents. They are
 *   gated (`CLINE_GATED_TOOL_NAMES` lists them regardless) but not surfaced,
 *   because shipping a second orchestration system inside the first is a
 *   decision to take on purpose, not by default.
 * - **`enableSpawnAgent: false`.** Subagent output arrives interleaved on the
 *   one process-wide subscription with only a `teamAgentId` to tell it apart,
 *   and callboard's `AgentEvent` union has no subagent dimension to render it
 *   into. Enabling it before there is somewhere to put the output would produce
 *   a transcript where two agents talk over each other. The permission gate is
 *   ready for it (`spawn_agent` → `codeExecution`) when the rendering is.
 *
 * `checkpoint` is left at its default of **disabled**. It would give
 * `restore()` — Cline's native fork — something to fork from, but it does so by
 * writing git stashes and refs into the user's repository on every run.
 * Callboard already owns forking through its transcript and its worktrees, so
 * the cost is real and the benefit duplicated. See `ClineSessionProvider`.
 */
export function buildClineStartConfig(input: BuildClineConfigInput): ClineCoreStartConfig {
  const { cline, cwd, sessionId, extraTools } = input;
  const providerId = cline.providerId?.trim() || DEFAULT_CLINE_PROVIDER_ID;
  const modelId = cline.model?.trim() ?? "";

  if (!modelId) {
    // Not thrown: Cline resolves its own default when the id is empty, and a
    // hard failure here would make "start a chat before picking a model"
    // impossible. Worth a line in the log so a chat on an unexpected model is
    // explicable.
    log.debug(`no model id for provider "${providerId}" — deferring to Cline's default`);
  }

  return {
    sessionId,
    cwd,
    providerId,
    modelId,
    ...(cline.apiKey?.trim() ? { apiKey: cline.apiKey.trim() } : {}),
    ...(cline.baseUrl?.trim() ? { baseUrl: cline.baseUrl.trim() } : {}),
    // `systemPrompt` is required by `CoreSessionConfig`, so there is no "let
    // Cline decide" — the default has to be requested explicitly. It is
    // workspace-aware, which is why `cwd` is threaded in rather than called
    // with no arguments.
    systemPrompt: cline.systemPrompt?.trim() || getClineDefaultSystemPrompt({ cwd, workspaceRoot: cwd, providerId }),
    ...(typeof cline.maxIterations === "number" && cline.maxIterations > 0 ? { maxIterations: cline.maxIterations } : {}),
    ...translateEffort(cline.effort),
    enableTools: true,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    yolo: false,
    ...(extraTools.length > 0 ? { extraTools } : {}),
  };
}
