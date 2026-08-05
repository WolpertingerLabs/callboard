/**
 * Options adapter: callboard run options → pi's session construction inputs.
 *
 * Mirrors `adapters/cline/optionsAdapter.ts` in role — `services/claude.ts`
 * builds a loosely-typed options bag and exactly one module per adapter turns it
 * into that engine's config. Everything pi-shaped lives here so the query stays
 * about lifecycle.
 *
 * ## Why this file builds *services*, not a `createAgentSession()` call
 *
 * The obvious entry point is `createAgentSession(opts)`, and it is the one the
 * plan's surface table named. The spike found it unusable, for a reason that is
 * a security property rather than an ergonomic one: **`createAgentSession()`
 * never resolves project trust**, and `SettingsManager.create()` defaults
 * `projectTrusted` to `true`. Measured against 0.83.0, opening a session on a
 * repo containing `.pi/extensions/*.ts` executed that TypeScript in-process, at
 * load time, before the first model call — with the trust store holding no
 * decision at all.
 *
 * Callboard opens whatever repository the user (or an agent) points it at, so
 * that is a remote-code-execution path, not a papercut. `createAgentSessionServices`
 * is the only exported entry that accepts `resourceLoaderReloadOptions`, which is
 * where `resolveProjectTrust` lives. {@link buildPiServicesOptions} is therefore
 * the *only* sanctioned way into a pi session in this adapter, and
 * `permissionAdapter.assertTrustDenied` exists to fail a test if a future edit
 * swaps the convenience entry point back in.
 *
 * @see plans/pi-adapter.md
 * @see plans/pi-spike-findings.md (§2 — the blocking finding, measured)
 */
import { join } from "node:path";
import {
  SettingsManager,
  type CreateAgentSessionServicesOptions,
  type CreateAgentSessionFromServicesOptions,
  type ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { EffortLevel } from "shared/types/index.js";
import { DATA_DIR } from "../../../utils/paths.js";
import { createLogger } from "../../../utils/logger.js";
import { customSkillsService } from "../../../services/custom-skills-service.js";
import { PI_EXTENSION_NAME, type PiPermissionExtension } from "./permissionAdapter.js";

const log = createLogger("pi-options");

/**
 * pi's thinking vocabulary, read off the option type rather than transcribed.
 *
 * `ThinkingLevel` originates in `@earendil-works/pi-agent-core`, which is a
 * *nested* dependency of `pi-coding-agent` rather than a hoisted one — importing
 * it directly would depend on npm's layout, which is true today and not
 * guaranteed. Deriving it from the option callboard already imports keeps the
 * coupling to the one package `backend/package.json` names. Same reasoning as
 * `cline/optionsAdapter.ts` does for `ReasoningEffort`.
 */
export type PiThinkingLevel = NonNullable<CreateAgentSessionFromServicesOptions["thinkingLevel"]>;

/**
 * The `options.pi` sub-object `services/claude.ts` populates for a pi chat.
 * Same shape of contract as `options.cline` and `options.codex`.
 */
export interface PiRunOptions {
  /** pi provider id — `"openrouter"`, `"anthropic"`, `"google"`, … */
  providerId?: string;
  /** Model id within that provider, e.g. `"google/gemini-3.6-flash"`. */
  model?: string;
  /** Provider API key. Injected at runtime; never written to pi's auth.json. */
  apiKey?: string;
  /**
   * Base URL override, for a self-hosted or OpenAI-compatible endpoint.
   *
   * Not the OpenRouter route: `openrouter` is one of pi's own provider ids (the
   * spike measured 307 OpenRouter models in the offline catalog), so it needs
   * only `providerId` and `apiKey`.
   */
  baseUrl?: string;
  /** Reasoning effort for capable models. */
  effort?: EffortLevel;
}

/** pi's default provider when settings name none. */
export const DEFAULT_PI_PROVIDER_ID = "openrouter";

/**
 * callboard's own pi config directory.
 *
 * A **function**, not a module const, so a per-test `CALLBOARD_DATA_DIR` is
 * honoured — `DATA_DIR` itself is captured at module load, but re-reading it
 * through a call keeps the seam in one place for Phase 2's
 * `resolvePiSessionsRoot()` to follow.
 *
 * Never `~/.pi/agent`. A callboard chat must not read or mutate the user's own
 * pi login, settings or trust store, and two chats on different providers must
 * not fight over one auth.json. Decision 4 in the plan.
 */
export function resolvePiAgentDir(): string {
  return join(DATA_DIR, "pi-agent");
}

/**
 * Translate callboard's `EffortLevel` onto pi's `thinkingLevel`.
 *
 * The vocabularies line up exactly once `"none"` is handled: pi spells "no
 * reasoning" as `"off"`, and carries `minimal`/`low`/`medium`/`high`/`xhigh`
 * verbatim.
 *
 * **`"off"` is not always safe.** The spike hit a hard `400: "Reasoning is
 * mandatory for this endpoint and cannot be disabled."` from
 * `google/gemini-3.6-flash` — a whole class of models refuses to have reasoning
 * turned off. `undefined` (no effort recorded on the chat) therefore returns
 * `{}` and lets pi pick its own default rather than defaulting to `"off"`, which
 * would break those models for every chat that never touched the effort control.
 * An explicit `"none"` still maps to `"off"`: the user asked for it, and the
 * provider's own error is the honest answer if the model refuses.
 */
export function translateThinkingLevel(effort: EffortLevel | undefined): { thinkingLevel?: PiThinkingLevel } {
  if (!effort) return {};
  if (effort === "none") return { thinkingLevel: "off" };
  return { thinkingLevel: effort satisfies PiThinkingLevel };
}

export interface BuildPiServicesInput {
  cwd: string;
  /** The permission gate, as an inline extension factory. Never optional. */
  extension: PiPermissionExtension;
  /** Directory pi reads global config from. Defaults to {@link resolvePiAgentDir}. */
  agentDir?: string;
  /**
   * Skill roots to load despite `noSkills`. Defaults to
   * {@link resolveCallboardSkillPaths}; tests pass their own.
   */
  skillPaths?: string[];
}

/**
 * Callboard's own custom-skills directory, as a `additionalSkillPaths` list.
 *
 * Empty when the user has authored no skills, so a session with none adds
 * nothing to pi's resource surface.
 */
export function resolveCallboardSkillPaths(): string[] {
  try {
    const dir = customSkillsService.getSkillsDir();
    return dir ? [dir] : [];
  } catch (err) {
    // Never fatal: a chat without custom skills is degraded, not broken.
    log.warn(`Failed to resolve callboard custom-skills directory for pi: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Build the `createAgentSessionServices()` input for one chat.
 *
 * Three settings carry the whole of §2's mitigation, and none of them is
 * optional or a preference:
 *
 * 1. **`settingsManager` with `projectTrusted: false`.** pi's own default is
 *    `true`. Relying on the default is the bug.
 * 2. **`resolveProjectTrust: async () => false`.** The only hook that runs
 *    *before* project-local extensions are evaluated. The spike confirmed the
 *    ordering directly: the marker file an untrusted extension writes at module
 *    load did not exist at the moment this callback ran, and never appeared.
 * 3. **`noExtensions: true`.** Belt and braces. `extensionFactories` survives it
 *    — measured — so callboard's gate loads while the project's code does not.
 *
 * Callboard has no trust UI yet, so the answer is a constant `false`. When one
 * lands this becomes a real prompt; until then a hardcoded denial is the honest
 * behaviour, and it is the safe direction to be wrong in.
 *
 * `noSkills` / `noPromptTemplates` / `noThemes` are set for the same reason:
 * they are *separate* flags from `noExtensions`, and project-local skills are
 * also trust-gated content that pi would otherwise load off the opened repo.
 * `noContextFiles` is deliberately **left off** — AGENTS.md and CLAUDE.md are
 * data the model reads, not code pi executes, and they are the whole point of
 * pointing an agent at a repository.
 *
 * ## Callboard's own skills, without reopening the hole
 *
 * `noSkills: true` stays exactly as it is. It is not relaxed, and flipping it to
 * `false` to get custom skills would be the skills-shaped version of dropping
 * `noExtensions` — it would re-admit `.pi/skills/` from the opened repository,
 * which is trust-gated content for the same reason extensions are.
 *
 * Instead `additionalSkillPaths` carries callboard's *own* skills directory
 * through the blanket disable, precisely as `extensionFactories` carries the
 * permission gate through `noExtensions`. The seam is real rather than
 * incidental — `resource-loader.js` branches on the flag and keeps the
 * additional paths on both sides:
 *
 * ```js
 * const skillPaths = this.noSkills
 *     ? this.mergePaths(cliEnabledSkills, this.additionalSkillPaths)
 *     : this.mergePaths([...cliEnabledSkills, ...enabledSkills], this.additionalSkillPaths);
 * ```
 *
 * `enabledSkills` — the discovered project-local and user set — is what the
 * flag drops, and `loadSkills` is then called with `includeDefaults: false`, so
 * nothing is scanned that callboard did not name. `customSkills.test.ts` asserts
 * both halves against real pi, with a control proving the project skill is
 * genuinely discoverable and the negative assertion therefore has teeth.
 *
 * One correction to the note above, measured rather than assumed: project-local
 * skills are gated by trust *and* by this flag, and **either alone suffices**.
 * The full matrix, pinned in `customSkills.test.ts`:
 *
 * | projectTrusted | noSkills | repo's `.pi/skills` |
 * |---|---|---|
 * | true  | false | **loaded** — the only exposed cell |
 * | true  | true  | not loaded |
 * | false | false | not loaded |
 * | false | true  | not loaded — what this adapter ships |
 *
 * So `noSkills` here is defence in depth, exactly as `noExtensions` is beside
 * `resolveProjectTrust`, rather than the single lock. Both are kept: neither is
 * load-bearing alone, and that is the point.
 *
 * **What this does and does not claim.** The property is that a repository's
 * skills are never *loaded*: they do not enter the system prompt, and — unlike
 * `.pi/extensions/` — nothing is executed. It is not a claim that the files are
 * unreachable. A model can still `read` a markdown file inside the workspace it
 * was pointed at, and a live run was observed doing exactly that when asked to
 * find a skill (see `PiAdapter.live.test.ts`). That read is governed by the
 * `fileRead` axis like any other, which is the correct boundary for content the
 * model chooses to open. Silent injection into the prompt is the trust boundary;
 * legibility of a file in the open workspace is not.
 *
 * **Where pi differs from the other harnesses.** On Claude and OpenRouter these
 * skills arrive as a synthetic `callboard` *plugin* and are invoked as
 * `callboard:<name>`. pi has no plugin concept and no namespacing: it reads the
 * frontmatter `name` verbatim, and its validator rejects `:` outright
 * (`^[a-z0-9-]+$`), so a pi chat sees the bare `<name>`. That is a naming
 * difference in the UI, not a difference in which skills load.
 */
export function buildPiServicesOptions(input: BuildPiServicesInput): CreateAgentSessionServicesOptions {
  const agentDir = input.agentDir ?? resolvePiAgentDir();
  const skillPaths = input.skillPaths ?? resolveCallboardSkillPaths();
  return {
    cwd: input.cwd,
    agentDir,
    settingsManager: SettingsManager.create(input.cwd, agentDir, { projectTrusted: false }),
    resourceLoaderReloadOptions: {
      resolveProjectTrust: async () => false,
    },
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [{ name: PI_EXTENSION_NAME, factory: input.extension, hidden: true }],
      // Omitted entirely when empty: pi records a diagnostic for a named path
      // that does not exist, and "user has no custom skills" is not a fault.
      ...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
    },
  };
}

export interface BuildPiSessionInput {
  pi: PiRunOptions;
  /** Resolved pi model, or undefined to let pi pick its own default. */
  model?: CreateAgentSessionFromServicesOptions["model"];
  /** callboard's own tools, already translated by `toolAdapter`. */
  customTools: PiToolDefinition[];
  /** Tool allowlist/denylist from the permission axes, from `buildToolFilters`. */
  filters: { tools?: string[]; excludeTools?: string[] };
}

/**
 * Build the per-session half of the construction — everything that is resolved
 * *against* the services rather than alongside them.
 *
 * Split from {@link buildPiServicesOptions} because pi splits it: services are
 * cwd-bound infrastructure (trust, settings, extensions, model runtime) and the
 * session options are resolved after those exist. Keeping the same seam means
 * the model lookup can use the services' `ModelRuntime` instead of building a
 * second one.
 */
export function buildPiSessionOptions(input: BuildPiSessionInput): Omit<CreateAgentSessionFromServicesOptions, "services" | "sessionManager"> {
  const { pi, model, customTools, filters } = input;

  if (!model) {
    // Not thrown: pi resolves its own default when no model is given, and a hard
    // failure here would make "start a chat before picking a model" impossible.
    // Worth a line so a chat on an unexpected model is explicable.
    log.debug(`no resolved model for provider "${pi.providerId ?? DEFAULT_PI_PROVIDER_ID}" — deferring to pi's default`);
  }

  return {
    ...(model ? { model } : {}),
    ...translateThinkingLevel(pi.effort),
    ...(customTools.length > 0 ? { customTools } : {}),
    ...(filters.tools ? { tools: filters.tools } : {}),
    ...(filters.excludeTools ? { excludeTools: filters.excludeTools } : {}),
  };
}
