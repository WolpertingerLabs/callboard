/**
 * Engine status — what Settings → API needs to tell the truth about the five
 * engines callboard can run a chat on.
 *
 * ## Why this is not an "installed" boolean
 *
 * Four of the five engines ship *inside* the callboard npm package as ordinary
 * dependencies (`@openai/codex-sdk`, `@cline/sdk`,
 * `@earendil-works/pi-coding-agent`, and the Claude Agent SDK). An
 * "installed ✓/✗" column would therefore print ✓ forever and teach the user
 * nothing. The axis that actually varies is
 * **`runtime × version × credentials`** — three orthogonal facts, never one
 * flag:
 *
 * - **runtime** — is this bundled with callboard, or a binary on the user's
 *   PATH, and *where did it resolve from*;
 * - **version** — what is running, and what npm currently publishes;
 * - **credentials** — configured or not, and from which source.
 *
 * Only two entries have an install step a user can take at all: an ACP vendor's
 * CLI, and the *preferred* native `claude` that
 * `getClaudeCodeExecutablePath()` picks over the SDK's bundled binary.
 *
 * These types live in `shared/` because both `backend/src/services/engine-status.ts`
 * (which assembles them) and `frontend/.../EngineStatusCard.tsx` (which renders
 * them) need the same shape. They are **not** part of the SSE wire surface —
 * `shared/types/stream.ts` is untouched by this feature and
 * `wire-surface.snapshot.json` must not move.
 *
 * @see plans/engine-availability-and-install.md — Phase 1
 */

/**
 * How an engine reaches the machine, and where it resolved from.
 *
 * The discriminant is the thing a user can act on: `bundled` means "updates
 * when callboard does", `external` means "you install this yourself".
 */
export type EngineRuntime =
  /** In-process library shipped inside the callboard package. Nothing to install, nothing to point elsewhere. */
  | { kind: "bundled"; package: string; dependencyRange?: string; pinned?: boolean }
  /**
   * Bundled, but the engine accepts a path to a user-supplied binary.
   *
   * `overridePath` is always absent in Phase 1 — the Codex SDK's
   * `codexPathOverride` exists and callboard does not pass it yet (Phase 4).
   */
  | { kind: "bundled-overridable"; package: string; overridePath?: string; dependencyRange?: string; pinned?: boolean }
  /**
   * A bundled fallback exists, but an external install on PATH is *preferred*
   * and wins when present — the Claude Code shape.
   *
   * `package` is the npm package that provides the preferred external CLI, so
   * `version` / `latestVersion` describe that CLI. `fallbackPackage` /
   * `fallbackVersion` describe what runs when nothing resolves on PATH, so the
   * card can still name a version in that state.
   */
  | {
      kind: "external-preferred";
      package: string;
      /** The binary looked for on PATH, so a "not found" message can name it. */
      command: string;
      /** Absolute path of the external CLI, when one resolved. Absent ⇒ the bundled fallback runs. */
      resolvedPath?: string;
      fallbackPackage: string;
      fallbackVersion?: string;
    }
  /** An external binary spawned per turn, with nothing bundled behind it — the ACP vendors. */
  | { kind: "external"; command: string; resolvedPath?: string; package?: string };

/**
 * Whether the engine has usable credentials, and where they came from.
 *
 * ## Why this is not a boolean
 *
 * For several engines callboard genuinely **cannot tell**, and a `false` there
 * is the dishonest-✓ failure inverted: it is wrong on every machine that *is*
 * authenticated, and — because it varies with nothing — it can never become
 * `true`, so the tab's status dot could never go green.
 *
 * - **ACP vendors**: the protocol carries no auth introspection. `initialize`
 *   advertises `authMethods`, never who is signed in. A vendor may well have
 *   credentials on disk (OpenCode keeps them under its own data dir); callboard
 *   does not read other tools' credential stores to find out.
 * - **Cline and pi**: an unset key in Settings means the embedded runtime falls
 *   back to the backend process's own environment, and which variable that is
 *   depends on the configured provider id.
 *
 * So `configured` is tri-state. `"unknown"` means "callboard did not and cannot
 * observe this", which is a different claim from `false` ("callboard looked at
 * the place credentials live for this engine, and there are none").
 *
 * Consumers must compare against `true` explicitly — `"unknown"` is truthy.
 */
export type EngineCredentialState = boolean | "unknown";

export interface EngineCredentials {
  configured: EngineCredentialState;
  /** Human-readable source label — `"auth.json"`, `"settings"`, an SDK `tokenSource`, … */
  source?: string;
  note?: string;
}

/** One engine, as Settings → API renders it. */
export interface EngineStatus {
  /** `"claude-code" | "codex" | "cline" | "pi"`, or an ACP vendor id. */
  id: string;
  label: string;
  runtime: EngineRuntime;
  /**
   * Can this engine run at all?
   *
   * Bundled and bundled-overridable ⇒ `true`: the library is a dependency, so
   * its presence is the install tree's problem, not the user's. `external` ⇒ a
   * PATH lookup. `external-preferred` ⇒ *checked*, not assumed: the bundled
   * fallback is an **optional** dependency (a per-platform native binary), so
   * `--omit=optional` or an unpublished platform can leave neither it nor a
   * native CLI — and `runtime.resolvedPath` says which of the two you got when
   * one is there.
   */
  installed: boolean;
  /** Version of whatever `runtime.package` / `runtime.command` names, when it could be read. */
  version?: string;
  /** Latest version npm publishes for that package. Absent when offline, or when nothing was asked — never an error. */
  latestVersion?: string;
  /** `version` < `latestVersion`. A fact, not an affordance: bundled engines still update only with callboard. */
  updateAvailable?: boolean;
  /**
   * When {@link latestVersion} was actually fetched, ISO-8601.
   *
   * Present whenever a version is. Paired with {@link latestVersionStale} it
   * lets the UI age the claim: a cached answer that could not be refreshed is
   * still worth showing, but "up to date" asserted from a week-old fetch is not
   * the same statement as one asserted from a fresh one.
   */
  latestVersionCheckedAt?: string;
  /** The cached answer is past its TTL and the refetch failed — treat {@link latestVersion} as "last known". */
  latestVersionStale?: boolean;
  credentials: EngineCredentials;
  // Phase 2 adds `install?: EngineInstallRecipe` here — the copyable command for
  // the two engines that have one. Deliberately absent in Phase 1.
}

/** `GET /api/engines`. */
export interface EngineStatusResponse {
  engines: EngineStatus[];
}
