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

/**
 * How a recipe's command reaches the machine.
 *
 * - `npm-global` — an `npm install -g <literal package>` with an argv array
 *   behind it. This is the only method Phase 3 will ever be allowed to run.
 * - `script` — a vendor's own `curl … | bash` installer. **Copy-only, forever.**
 *   Callboard offers the text and never runs it: piping the internet into a
 *   shell on a user's behalf is not something a settings page gets to do, and
 *   the type enforces it — a `script` recipe carries no {@link
 *   EngineInstallRecipe.argv}, so there is nothing to hand `execFile`.
 *
 * @see plans/engine-availability-and-install.md — Decisions 4 and 5
 */
export type EngineInstallMethod = "npm-global" | "script";

/**
 * One command a user can copy, for one engine.
 *
 * The package name is a **literal in the recipe registry** and never assembled
 * from a request — see `backend/src/services/engine-install-recipes.ts`.
 */
export interface EngineInstallRecipe {
  /** The {@link EngineStatus.id} this belongs to. */
  engineId: string;
  method: EngineInstallMethod;
  /** Short name for the method, as the card labels it — "npm (global)", "Official installer". */
  label: string;
  /** The npm package, verbatim. Present on `npm-global` only. */
  package?: string;
  /**
   * `execFile`-style argv. Present on `npm-global` only, absent on `script`.
   *
   * Nothing in Phase 2 executes this — it exists so Phase 3 has a closed,
   * literal set to spawn without ever building argv from user input.
   */
  argv?: readonly string[];
  /** Exactly what to type. This is the string the copy button puts on the clipboard. */
  command: string;
  /** Vendor documentation for this install path. */
  docsUrl: string;
  /**
   * Will the daemon's own "Recheck" see the result of this command?
   *
   * `true` for `npm-global`: the global bin directory is normally already on
   * the PATH the daemon inherited, so re-running `which` finds the new binary.
   * (`caveats` names the two cases where it does not.)
   *
   * `false` for the vendor scripts, which install into a directory they add to
   * your *shell rc* — `~/.opencode/bin`, `~/.local/bin`. A running process's
   * PATH is fixed at exec, so Recheck cannot see those however many times it is
   * pressed, and the card must not tell someone to press it.
   */
  visibleAfterRecheck: boolean;
  /**
   * Conditions under which the command above would not do what it says.
   *
   * Rendered verbatim, because a copyable command *is an instruction*: a recipe
   * that tells a user to run something that cannot work on their machine (a
   * bash-only script on Windows, a global install under a non-writable prefix,
   * an nvm-managed Node where the install lands under a different version) is
   * the same class of bug as an "installed ✓" that is always ✓. Callboard does
   * not detect these in Phase 2 — it states them.
   */
  caveats?: readonly string[];
}

/**
 * What a user can actually do about an engine that is not ready, if anything.
 *
 * Attached to {@link EngineStatus.install} only when there is a real action.
 * Absent means "nothing to install" — which for four of the five engines is the
 * permanent answer, and for a working install is the current one.
 *
 * Deliberately a *set* of recipes rather than the single one the plan's sketch
 * named: the same engine has both an npm path and a vendor-script path, and
 * only one of the two can be a Phase-3 button.
 *
 * `recipes` may be **empty**, and that is a distinct and important state: the
 * CLI is already installed and only a login is missing, so there is something
 * to say and nothing to install. A card that offered an install command there
 * would be telling the user to install what they already have — which is what
 * the previous cut of the Codex block did, including to anyone who had just
 * followed its own recipe.
 */
export interface EngineInstallGuidance {
  /** Why this is being offered — "no `opencode` on PATH", "`codex login` needs the CLI". */
  reason: string;
  /**
   * What installing does and does not change, when that is not obvious.
   *
   * The Codex recipe is the reason this field exists: installing `@openai/codex`
   * makes `codex login` runnable, and changes nothing about which binary a chat
   * runs. A card that read "install Codex" would be actively wrong.
   */
  scope?: string;
  /** The alternative that needs nothing installed, where there is one (an API key on this tab). */
  alternative?: string;
  recipes: EngineInstallRecipe[];
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
  /**
   * A copy of this engine's CLI the **user** can run in their own terminal,
   * when one exists and is not the copy Callboard runs for chats.
   *
   * This field exists because "is the CLI installed" and "will Callboard use
   * it" are different questions, and the login commands this feature points
   * people at (`claude auth login`, `codex login`) only need the first:
   *
   * - **Claude Code** — `getClaudeCodeExecutablePath()` decides what the Agent
   *   SDK runs and looks only at the setting and `which claude`.
   *   `getClaudeBinaryPath()` — the lookup the About page and the login prompt
   *   use — additionally checks `CLAUDE_BINARY` and `~/.local/bin`,
   *   `~/.claude/bin`, `/usr/local/bin`, `/opt/homebrew/bin`. A daemon started
   *   before those were on its `PATH` sees the second and not the first, which
   *   is the *normal* outcome of the `install.sh` recipe.
   * - **Codex** — Callboard always runs the binary nested inside
   *   `@openai/codex-sdk`, so a user-installed `codex` on `PATH` changes
   *   nothing about chats and everything about whether `codex login` exists.
   *
   * Absent means "looked and found none", and the card may then say the CLI is
   * missing. Asserting that from the narrower lookup alone is how a card tells
   * someone to install a binary they are looking at.
   */
  userCliPath?: string;
  /**
   * What the user can do about this engine, when there is anything.
   *
   * Usually a copyable command; sometimes — when the CLI is already there and
   * only a login is missing — just a sentence, with `recipes` empty. Absent is
   * the common and correct case: a bundled engine has nothing to install
   * *ever* (a global install cannot reach Callboard's nested `node_modules`),
   * and a working, credentialed engine has nothing to do *now*.
   */
  install?: EngineInstallGuidance;
}

/** `GET /api/engines`. */
export interface EngineStatusResponse {
  engines: EngineStatus[];
}

/**
 * `POST /api/engines/refresh`.
 *
 * `probed` is the honest bit. The endpoint drops five caches and re-runs a
 * `which` per engine, two `--version` spawns and an Agent SDK query, two of
 * them synchronously on a single-threaded server — so it is rate-limited, and
 * a call inside the window gets the cached statuses back instead. Reporting
 * that as a successful re-probe would make "Recheck" claim work it did not do,
 * which is the same defect as an install command that cannot help.
 */
export interface EngineRefreshResponse extends EngineStatusResponse {
  /** Did this call actually re-probe, or was it coalesced with another / served from cache? */
  probed: boolean;
  /** Roughly how long until a probe would run, when `probed` is false. */
  retryAfterMs?: number;
}
