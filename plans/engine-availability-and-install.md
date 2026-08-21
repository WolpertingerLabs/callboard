# Engine availability and install management

Give Settings → API an honest, per-engine answer to two questions a user cannot
answer today — **"is this engine actually usable on this machine?"** and
**"what do I run to install or update it?"** — and make the second one a button
wherever a button can be honest.

Status: planned. Phases are ordered so each is a separate PR that leaves the
tree compiling and green. Phases 0–2 ship real value with **zero** process
execution; Phase 3 is the only one that shells out.

## The finding that reshapes the request

The request assumes five engines that are each independently installed on the
machine. Measured against the installed tree, that is true for **one** of them.
Three ship *inside* the callboard tarball as ordinary npm dependencies, and a
fourth is bundled-but-overridable:

| Engine | How it actually runs | What "installed" can honestly mean | Real update path |
|---|---|---|---|
| **Claude Code** | `@anthropic-ai/claude-agent-sdk` (bundled; per-platform native binaries as optional deps) — but `getClaudeCodeExecutablePath()` **prefers a native `claude` on PATH** and only falls back to the bundled binary | SDK: always present. Native CLI: genuinely present-or-not, and preferred | CLI: `npm i -g @anthropic-ai/claude-code` or the native installer. SDK: bump callboard |
| **Codex** | `@openai/codex-sdk` → `@openai/codex` → platform binary `@openai/codex-<plat>`, all installed with callboard. `codexPathOverride` exists in the SDK and callboard does not use it | Binary: always present. The real gate is **auth**, which `codexConfigured` / `codexAuthSource` already report | Bump callboard (or, after Phase 4, point at a user-installed `codex`) |
| **Cline** | `@cline/sdk` → `@cline/core`, pure JS, in-process | Always present | Bump callboard |
| **pi** | `@earendil-works/pi-coding-agent`, in-process library (its `pi` bin is unused) | Always present | Bump callboard |
| **ACP / OpenCode** | External `opencode` binary on PATH, spawned per turn | Genuinely install-or-not — already detected by `adapters/acp/availability.ts` | `npm i -g opencode-ai`, or the vendor's install script |

So a literal "installed ✓/✗" column would print ✓ for four engines forever and
teach the user nothing. **The axis that varies is not presence — it is
`runtime × version × credentials`,** and only two entries in the table
(OpenCode, and the *preferred* native `claude`) have an install step a user can
take at all.

The feature is still worth building; it just has to describe what is true. Two
supporting facts make that easy to get wrong, so they are stated up front:

- **The README documents none of this.** It names the Claude Code CLI as a
  requirement and never mentions Codex, Cline, pi or OpenCode. A user who sees
  five tabs in Settings → API has no document that tells them which need
  anything installed. Phase 0 fixes that alone, at no code cost.
- **Three caches memoize "is it installed" for the process lifetime** —
  `availability.ts`'s `cache` (per ACP command), `agent-settings.ts`'s
  `resolvedClaudePath`, and `paths.ts`'s `_claudeBinaryPath`. All three are
  correct today, because PATH does not change under a running daemon. The
  moment callboard can *install* an engine, that premise is false and stale
  caches make a successful install read as a failure. Invalidation is a Phase 2
  deliverable, before any install button exists.

## Decisions

Settled before work starts.

1. **Three orthogonal facts per engine, never one boolean.** *Runtime*
   (bundled / external / bundled-with-override, and where it resolved from),
   *version* (installed, and latest known), *credentials* (configured, and from
   which source). Collapsing them into "installed" is what produces the
   dishonest ✓ column.
2. **Bundled engines never get an "Update" button.** Their version is a
   dependency range in callboard's manifest — `@cline/sdk` and
   `@earendil-works/pi-coding-agent` are pinned *exactly*, and the Codex adapter
   already warns on drift from `EXPECTED_CODEX_CLI_VERSION` because the rollout
   format is version-dependent. Letting a user `npm i -g @cline/sdk@latest` into
   callboard's tree is a silent way to break the adapters. Their honest action
   is "Update Callboard", linking to the About page's existing notice.
3. **A new `GET /api/engines` endpoint, not more fields on `/api/system-info`.**
   System-info is polled by several pages and already carries
   `acpProviders` / `codexConfigured` / `codexAuthSource`; those stay exactly as
   they are (older bundles read them). Engine status is a different cadence —
   it hits the npm registry and, later, the filesystem — and deserves its own
   route with its own cache.
4. **Install recipes are a static registry, and argv is never assembled from
   user input.** `{ engineId, method, package, argv }`, spawned with
   `execFile`-style argv arrays. The set of installable packages is closed.
5. **`curl | bash` installers are copy-only, never one-click.** OpenCode's own
   script and Anthropic's native installer are offered as text to run in a
   terminal. Callboard does not pipe the internet into a shell on the user's
   behalf.
6. **No uninstall, no downgrade, no version pinning in the UI.** Install and
   update-to-latest only. Everything else is a terminal's job.
7. **One-click install is scoped and revocable.** It is the only phase that
   executes anything, it is gated (Phase 3), and the copyable command remains
   visible so the feature degrades to Phase 2 rather than to nothing.
8. **Phase 2 is Phase 3's fallback, structurally and not just in spirit.** Every
   path that can refuse a one-click install — a tunneled client, a non-writable
   global prefix, `allowEngineInstalls` off, a spawn that fails, an install that
   exits non-zero — lands the user on the Phase-2 copy-command for that same
   engine, with a one-line reason. There is no state in which the UI offers an
   install button, declines to run it, and leaves the user with nothing to type.
   Phase 3 therefore adds a shortcut to Phase 2; it never replaces it, and the
   copy block stays rendered alongside the button rather than behind a failure.

## Phase 0 — Document the engines (no code)

`README.md` gains an **Engines** section: the table at the top of this document,
in user-facing language, plus per-engine install commands and what each one
needs to be authenticated. Ship it first — it is the whole feature for anyone
reading docs instead of clicking, and it forces the vocabulary the UI will use.

Also settle the word. The code says *provider* (`UiAgentProviderKind`) and
*harness*; the product says *engine*. Pick **engine** for user-facing copy and
leave the type names alone — renaming `AgentProviderKind` is not in scope, and
a doc-comment on `providers.ts` pointing at the user-facing term is enough.

## Phase 1 — Engine status, read-only

**New:** `backend/src/services/engine-status.ts` — one `EngineStatus` per
engine, assembled from what already exists rather than from new probes:

```ts
type EngineRuntime =
  | { kind: "bundled"; package: string }                                  // cline, pi
  | { kind: "bundled-overridable"; package: string; overridePath?: string } // codex
  | { kind: "external-preferred"; package: string; resolvedPath?: string }  // claude-code
  | { kind: "external"; command: string; resolvedPath?: string };           // acp vendors

interface EngineStatus {
  id: string;                    // "claude-code" | "codex" | "cline" | "pi" | acp vendor id
  label: string;
  runtime: EngineRuntime;
  installed: boolean;            // bundled ⇒ always true; external ⇒ PATH lookup
  version?: string;              // installed version
  latestVersion?: string;        // npm registry, cached
  updateAvailable?: boolean;
  credentials: { configured: boolean; source?: string; note?: string };
  install?: EngineInstallRecipe; // Phase 2 populates; absent ⇒ nothing to install
}
```

Sources, all of them already in the tree:

- **Versions**: `require("<pkg>/package.json").version` for bundled engines (the
  pattern `CodexSessionProvider.checkSdkVersionOnce` already uses);
  `claude --version` for the native CLI (already run for
  `system-info.claudeCliVersion`); `opencode --version` for ACP vendors, added
  to `AcpProviderAvailability` behind the same per-process cache.
- **Latest versions**: generalize the npm-registry fetch + 4-hour disk cache
  that `bin/callboard.js` and the `/api/system-info` handler each implement
  today into `services/npm-registry.ts`, keyed by package, cached at
  `~/.callboard/engine-versions.json`. Best-effort: an offline daemon returns
  status with `latestVersion` absent, never an error.
- **Credentials**: `sdk-info`'s `account.tokenSource` (Claude Code),
  `getCodexAuthSource()` (Codex), `clineProviderId` + key presence (Cline),
  `piProviderId` + key presence (pi), and for ACP the *honest non-answer* the
  availability module already documents — "held by the CLI; ACP has no auth
  introspection".

**New route** `GET /api/engines` (`backend/src/routes/engines.ts`), auth'd like
every other route, `?refresh=1` to bypass the registry cache.

**UI**: an `EngineStatusCard` rendered at the top of every tab in
`ApiSettings.tsx`, above `ReferenceLinksSection`, with rows Runtime / Version /
Latest / Credentials. The existing ACP tab body (`AcpProviderSection`) already
renders four rows of exactly this shape — it becomes the first consumer, not a
special case. Tab-strip buttons gain a status dot (installed + credentialed,
installed + uncredentialed, not installed) using existing `--status-*` /
`--badge-*` tokens; **any new CSS variable must be added to both `:root` and
`[data-theme="light"]` in `index.css` *and* to
`backend/src/services/theme-contrast-palette.ts`**, and the contrast tests run
repo-wide, not frontend-only.

Ends with: every tab tells the truth, nothing executes, no new failure mode.

## Phase 2 — Guided install, plus cache invalidation

1. **Recipe registry** `backend/src/services/engine-install-recipes.ts`:

   | Engine | Method | Command |
   |---|---|---|
   | Claude Code (native CLI) | `npm-global` | `npm install -g @anthropic-ai/claude-code` |
   | Claude Code (native CLI) | `script` (copy-only) | `curl -fsSL https://claude.ai/install.sh \| bash` |
   | OpenCode | `npm-global` | `npm install -g opencode-ai` |
   | OpenCode | `script` (copy-only) | the vendor's install script |
   | Codex / Cline / pi | `bundled` | none — "Update Callboard" |

   Each entry carries `docsUrl`. `npm-global` entries carry an argv array; the
   package name is a literal in this file and never arrives from a request.

2. **UI**: when `installed === false`, the status card shows the command in a
   copy-to-clipboard block plus a docs link — the shape `web-tunnel.ts`'s
   `INSTALL_HINT` already uses for `cloudflared`, promoted from a log string to
   a UI affordance. When the engine is bundled and out of date relative to
   callboard's own latest, the action is a link to About.

3. **`POST /api/engines/refresh`** — invalidate and re-probe. This is the phase
   that makes the three memoized caches addressable:
   - export a non-test `resetAcpAvailabilityCache()` (it exists as a test seam
     already),
   - add a reset for `agent-settings.ts`'s `resolvedClaudePath` — which also
     fixes a standing papercut, since editing `pathToClaudeCodeExecutable`
     currently requires a daemon restart to take effect,
   - add a reset for `paths.ts`'s `_claudeBinaryPath`.

   Wire the button as "Recheck" on every status card. Without it, Phase 3's
   success case renders as failure.

## Phase 3 — One-click install (the only phase that executes)

Runs `npm-global` recipes from the daemon and streams the output.

- **`POST /api/engines/:id/install`** → `{ installId }`, one install at a time
  (a module-level singleton, like `web-tunnel`'s supervisor).
  **`GET /api/engines/installs/:installId/stream`** → SSE via `utils/sse.ts`,
  emitting stdout/stderr lines and a terminal exit event; on success the server
  runs the Phase-2 refresh itself and emits the new `EngineStatus`.
- **Preflight, before spawning**: resolve `npm root -g` and check it is
  writable. A non-writable global prefix (a system Node without a user prefix)
  is the common failure and produces an EACCES wall of text; detect it and
  degrade to the Phase-2 copy-command with a one-line explanation instead of
  running a command that cannot succeed. Note that under nvm the global prefix
  is per-Node-version, so an install is only visible to a daemon running that
  same Node — worth saying in the UI when `process.execPath` sits under
  `~/.nvm`.
- **Security.** This is remote command execution by design, on a server whose
  own Remote Access feature can put it on the public internet with a password
  as the only barrier. Mitigations, all of them:
  - closed package allowlist, argv arrays, no shell, no user input in argv;
  - auth required (inherited);
  - **gated to loopback/LAN clients** via the existing `ip-allowlist.ts` /
    `client-ip.ts` helpers — a tunneled client sees the copy-command instead;
  - an `AgentSettings.allowEngineInstalls` toggle (default on for local
    clients) so an operator can switch the capability off entirely;
  - installs are logged like any other spawned process.

## Phase 4 — External-binary overrides (optional)

Makes "use *my* install, not the bundled one" a UI decision:

- surface `pathToClaudeCodeExecutable` as a field on the Claude Code tab (the
  setting exists and has never had one), with live validation against
  `existsSync` and the Phase-2 cache reset on save;
- add `codexPathOverride` — a new `AgentSettings` field passed through
  `optionsAdapter` into `CodexOptions` — so a user with their own `codex` can
  run it instead of the bundled binary. Pair it with the existing
  `EXPECTED_CODEX_CLI_VERSION` drift warning, surfaced in the status card
  rather than only in the log.

Cline and pi get no override: they are in-process libraries, not subprocesses,
and there is nothing to point elsewhere.

## Testing

- `engine-status.test.ts` — one case per runtime kind; bundled engines report
  `installed: true` with no install recipe; a missing external binary reports
  `installed: false` **with** one; registry failure degrades to absent
  `latestVersion` rather than a thrown route.
- `engine-install-recipes.test.ts` — every `npm-global` recipe's package is in
  the allowlist; no recipe interpolates a non-literal.
- `engines.route.test.ts` — shape, `?refresh=1`, and the Phase-3 client-scope
  gate (a non-local client gets the recipe, not the install endpoint).
- Cache invalidation: assert the three resets actually re-probe, by flipping a
  stubbed `which` result between calls.
- No new wire-surface entries: `shared/types/stream.ts` is untouched, so
  `wire-surface.snapshot.json` should not move. If it does, something was added
  in the wrong place.

## Open question for the first implementer

Phase 3 is the only phase with a real cost — an execution surface on a server
that can be internet-facing — and Phases 0–2 deliver most of the user value
without it. If that trade reads badly at implementation time, stopping after
Phase 2 leaves a coherent feature: every engine states what it is, what version
it runs, whether it is credentialed, and exactly what to type.
