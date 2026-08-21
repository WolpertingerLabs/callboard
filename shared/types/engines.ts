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
/**
 * What Callboard observed about a configured binary-override path.
 *
 * `"active"` is the only state in which the override is what runs. Every other
 * value means Callboard **rejected** the path and fell back — to `PATH` and then
 * the bundled binary for Claude Code, straight to the bundled binary for Codex.
 *
 * There are four of them rather than one `valid: boolean` because they fail
 * differently and a user fixes them differently: a typo, a directory, and a
 * downloaded file nobody `chmod +x`'d are three separate mornings.
 */
export type EngineOverrideState =
  /** The path exists, is a file, and carries an execute bit for the user running the daemon. This is what runs. */
  | "active"
  /** Nothing at that path. */
  | "missing"
  /** Something is there, but it is a directory (or a socket, or a device) rather than a file. */
  | "not-a-file"
  /** A file, with no execute permission for the daemon's user — `spawn` would fail with EACCES. */
  | "not-executable";

/**
 * A configured "run *my* binary" path, and whether it is actually in effect.
 *
 * The whole point of this shape is that `path` and "what runs" are **two
 * different facts**, and a card that prints the first while a chat uses the
 * second is this feature's signature bug. So the state is carried alongside the
 * path, always, and it is derived from a `stat` + an access check rather than
 * from the field being non-empty.
 */
export interface EngineBinaryOverride {
  /** Exactly what the user saved, verbatim — including if it is nonsense. */
  path: string;
  state: EngineOverrideState;
  /**
   * One sentence: what Callboard looked at, what it found, and what runs as a
   * result. Rendered directly, so it is written for a person and not for a log.
   */
  detail: string;
  /**
   * The overriding binary's own `--version`, when it is `"active"` and answered.
   *
   * Absent for a rejected override (nothing was run) and for one that is present
   * but did not print a version — which is itself worth knowing, since it is
   * usually a wrapper script or the wrong binary entirely.
   */
  version?: string;
}

export type EngineRuntime =
  /** In-process library shipped inside the callboard package. Nothing to install, nothing to point elsewhere. */
  | { kind: "bundled"; package: string; dependencyRange?: string; pinned?: boolean }
  /**
   * Bundled, but the engine accepts a path to a user-supplied binary.
   *
   * `overridePath` is set only when an override is **active** — i.e. it always
   * names the binary that runs, never merely one that was typed into a settings
   * field. {@link override} carries the fuller story, including the rejected
   * states; a consumer that only knows about `overridePath` still cannot be
   * misled by one.
   */
  | {
      kind: "bundled-overridable";
      package: string;
      overridePath?: string;
      override?: EngineBinaryOverride;
      dependencyRange?: string;
      pinned?: boolean;
    }
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
      /**
       * The `pathToClaudeCodeExecutable` setting, when one is saved.
       *
       * Present whether or not it worked — an override Callboard **rejected** is
       * exactly the state the user most needs to see, because from every other
       * row the card looks identical to having set nothing at all. When it is
       * `"active"`, `resolvedPath` is this same path.
       */
      override?: EngineBinaryOverride;
      /**
       * Where the *other* Claude lookup landed, when it disagrees with
       * `resolvedPath`.
       *
       * `getClaudeCodeExecutablePath()` (this row) decides what chats run;
       * `getClaudeBinaryPath()` decides what the About page reports a version
       * for and what the login prompt runs. They read different inputs — only
       * the first honours {@link override}, only the second reads
       * `$CLAUDE_BINARY` and `~/.local/bin` — so on a machine with both they can
       * name two different binaries. Set only when they actually differ, so the
       * card can say so instead of leaving the user to discover it from a
       * version number that will not move.
       */
      otherLookupPath?: string;
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
  /**
   * Phase 3: the one recipe this client may run from a button, when there is
   * one on offer.
   *
   * Absent is the *normal* answer, not an error state — see {@link refusal}.
   * Present means every gate passed at the moment this status was assembled:
   * the client is on the LAN, the operator has not switched the capability off,
   * the platform is one Callboard can spawn `npm` on without a shell, and npm's
   * global prefix resolved and is writable.
   */
  oneClick?: EngineOneClickOffer;
  /**
   * Phase 3: one line saying why there is no install button, when a runnable
   * recipe exists and no button is offered.
   *
   * Decision 8 is why this field exists. Every path that declines a one-click
   * install — a tunnelled client, `allowEngineInstalls` off, an unsupported
   * platform, a non-writable npm prefix, a `script`-only recipe — must land the
   * user on the copy block *above* with an explanation, rather than on a card
   * that quietly has one fewer button than it did on another machine. It sits
   * alongside {@link reason} rather than replacing it: `reason` says why the
   * engine needs attention, `refusal` says why Callboard will not give it that
   * attention itself.
   *
   * Present exactly when {@link recipes} is non-empty and {@link oneClick} is
   * absent *and* capability was evaluated. A caller that never evaluated install
   * capability (anything but the HTTP routes) leaves both fields absent, which
   * is the honest encoding of "nobody asked".
   */
  refusal?: string;
}

/**
 * The single recipe an install button would run, once every gate has passed.
 *
 * Carries the package and command verbatim so the button's tooltip can name
 * exactly what is about to run — the argv is *not* here, because the client
 * never supplies it: `POST /api/engines/:id/install` re-derives it from the
 * closed registry, and the `:id` only ever selects a recipe.
 */
export interface EngineOneClickOffer {
  engineId: string;
  /** The npm package, from the closed allowlist. */
  package: string;
  /** The equivalent shell command, for the button's title and for logs. */
  command: string;
  /**
   * A condition that is true *and* does not prevent the install — the nvm case.
   *
   * Under nvm the global prefix belongs to the active Node version, so a
   * successful install is visible only to a daemon running that same Node. That
   * is worth saying next to the button and is not a reason to withhold it: the
   * daemon doing the installing *is* the one that will look, so it usually
   * works. It is a warning, never a refusal.
   */
  note?: string;
}

/**
 * Whether this client may run an install, evaluated per request.
 *
 * Not cached with the engine statuses, and deliberately not part of them: the
 * same daemon answers "yes" to a browser on the LAN and "no" to the same
 * browser reaching it through the remote-access tunnel a minute later. Baking it
 * into the cached probe result would hand one client the other's verdict.
 */
export interface EngineInstallCapability {
  /** May this client press an install button at all? */
  oneClick: boolean;
  /** One line explaining why not. Always present when `oneClick` is false. */
  refusal?: string;
  /** Which gate said no. Always present when `oneClick` is false. Never used to *build* the sentence — it classifies one. */
  code?: EngineInstallRefusalCode;
  /** True-but-survivable condition to render beside the button. See {@link EngineOneClickOffer.note}. */
  note?: string;
}

/** Why an install was declined. Sent with the refusal so the UI can pick a status code's worth of nuance if it ever needs to. */
export type EngineInstallRefusalCode =
  /** The request came from outside the LAN — through the remote-access tunnel. */
  | "not-local"
  /** `AgentSettings.allowEngineInstalls` is off. */
  | "disabled"
  /** No `npm-global` recipe for this engine id — a bundled engine, or a `script`-only one. */
  | "no-recipe"
  /** Callboard cannot spawn `npm` without a shell here (Windows). */
  | "unsupported-platform"
  /** `npm root -g` did not answer. */
  | "npm-unresolvable"
  /** npm's global prefix is not writable by the user running the daemon. */
  | "prefix-not-writable"
  /** Another install is already running. One at a time. */
  | "busy"
  /**
   * An install finished moments ago.
   *
   * Every completed install ends in a *forced* re-probe of every engine, which
   * bypasses the rate limit Phase 2 put on that work. Bounding how often an
   * install may be accepted is what puts the bound back.
   */
  | "cooling-down"
  /** The process could not be spawned, or exited non-zero. */
  | "install-failed";

/** `POST /api/engines/:id/install`, when it starts one. */
export interface EngineInstallStartResponse {
  installId: string;
  engineId: string;
  package: string;
  command: string;
}

/** `POST /api/engines/:id/install`, when it does not. Always carries a one-line `refusal` for the card. */
export interface EngineInstallRefusalResponse {
  error: string;
  refusal: string;
  code: EngineInstallRefusalCode;
}

/** The first frame: what is about to run, named in full. */
export interface EngineInstallStartedEvent {
  type: "install_started";
  installId: string;
  engineId: string;
  package: string;
  command: string;
  startedAt: string;
}

/** One line of the child process's output, verbatim apart from ANSI stripping and a length clip. */
export interface EngineInstallOutputEvent {
  type: "install_output";
  stream: "stdout" | "stderr";
  line: string;
}

/**
 * The process is over. **Not** the user-facing verdict.
 *
 * `ok: true` means only "npm exited 0", which is not the same claim as
 * "the engine is installed" — the two diverge every time the global bin
 * directory is not on the PATH the daemon inherited. So a successful exit
 * carries no summary at all and is followed by an {@link EngineInstallVerifiedEvent};
 * a failed one is terminal and carries the `refusal` that sends the user back to
 * the copy block.
 */
export interface EngineInstallExitEvent {
  type: "install_exit";
  installId: string;
  engineId: string;
  ok: boolean;
  code: number | null;
  signal: string | null;
  durationMs: number;
  /** Present exactly when `ok` is false. */
  refusal?: string;
}

/**
 * What Callboard found when it looked again — the only event that may claim an
 * engine is installed.
 *
 * Emitted after a zero exit, once the server has run the Phase-2 refresh itself.
 * `visible: false` is the important case and the reason this event is separate:
 * `npm install -g` exited 0, and Callboard still cannot find the binary. That is
 * a refusal like any other and lands on the copy block with a reason, rather
 * than on a green tick that is wrong.
 */
export interface EngineInstallVerifiedEvent {
  type: "install_verified";
  installId: string;
  engineId: string;
  /** Did the re-probe actually find the thing the install was supposed to produce? */
  visible: boolean;
  /** One line for the card. States what was observed, never what was assumed. */
  summary: string;
  /** Present when `visible` is false — the install "worked" and Callboard still cannot see it. */
  refusal?: string;
  /** The re-probed statuses, so the page updates without a second round trip. */
  engines: EngineStatus[];
}

/** Everything `GET /api/engines/installs/:installId/stream` emits. */
export type EngineInstallEvent = EngineInstallStartedEvent | EngineInstallOutputEvent | EngineInstallExitEvent | EngineInstallVerifiedEvent;

/**
 * A version Callboard was written against, against the one it is actually
 * talking to.
 *
 * Only Codex carries this today, and the reason is specific rather than
 * general: the Codex rollout format (`$CODEX_HOME/sessions/**.jsonl`) is
 * undocumented and version-dependent, and `adapters/codex/sessionParser.ts`
 * translates it by hand. A format change does not throw — it produces a chat
 * that silently loses messages on resume. `EXPECTED_CODEX_CLI_VERSION` exists so
 * that outcome is *diagnosable*, and until Phase 4 the check that reads it could
 * not run at all: it resolved the SDK version through
 * `require("@openai/codex-sdk/package.json")`, which throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` into a bare `catch {}` on every boot.
 *
 * So this is not a cosmetic row. It is the difference between "parsing may be
 * lossy, here is why" and a bug report about vanishing messages.
 */
export interface EngineVersionDrift {
  /** The version the adapter was written against. */
  expected: string;
  /** The version actually in effect — the bundled package, or an active binary override. */
  actual: string;
  /** Where `actual` came from, so the sentence can name the binary rather than a package in the abstract. */
  source: "bundled" | "override";
  /** One line: what differs, and what it puts at risk. Rendered directly. */
  detail: string;
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
   * The version this engine's adapter targets is not the version it is running.
   *
   * Absent is the normal answer and the only one that means "checked and fine" —
   * see {@link EngineVersionDrift} for why the check matters and why, before
   * Phase 4, it could not fire.
   */
  drift?: EngineVersionDrift;
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
 * `GET /api/engines/binary-check?path=…` — "would Callboard accept this path?"
 *
 * Exists so the two override fields in Settings → API can answer while the user
 * is still typing, using the **same** check the resolver applies at chat time,
 * rather than a second implementation that agrees with it until it does not.
 *
 * It `stat`s and tests the execute bit. It deliberately does **not** run the
 * binary: a settings field that executes whatever is currently typed into it
 * would spawn a process per keystroke, and the version Callboard needs comes
 * from the status card after Save, where a path has actually been committed.
 */
export interface EngineBinaryCheckResponse {
  /** The path as sent, trimmed. Empty when the field is blank. */
  path: string;
  /**
   * `null` for a blank path — "nothing configured" is not a failure, it is the
   * default, and colouring an empty field red is how a settings page nags.
   */
  state: EngineOverrideState | null;
  /** One line for the field's help text. Empty string when `state` is null. */
  detail: string;
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
