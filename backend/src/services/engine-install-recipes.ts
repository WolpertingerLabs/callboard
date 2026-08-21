/**
 * The static registry of install commands — "what do I type to fix this?".
 *
 * ## What is in here, and what is deliberately not
 *
 * Every command below is a **literal**. Package names are written out in this
 * file and never assembled from a request, argv is an array rather than a
 * string, and the set of installable packages is closed
 * ({@link INSTALLABLE_PACKAGES}). That is Decision 4, and it is what lets
 * Phase 3 spawn one of these without the endpoint becoming an
 * arbitrary-command surface.
 *
 * **Nothing in this module executes anything.** It has no imports from
 * `node:child_process`, and it never will: Phase 2's whole deliverable is text a
 * user copies. A `script` recipe carries no `argv` at all, so even in Phase 3
 * there is nothing for `execFile` to receive — Decision 5 ("Callboard does not
 * pipe the internet into a shell on the user's behalf") is enforced by the
 * shape of the data and not by a rule someone has to remember.
 *
 * ## Only three engines appear here
 *
 * Cline and pi are in-process libraries, and Callboard's copy of the Claude
 * Agent SDK and the Codex SDK are ordinary nested dependencies. `npm i -g` of
 * any of those is **inert** — Node resolves the package from Callboard's own
 * `node_modules` first and the global prefix is not on that search path — so
 * offering it would be a button that silently changes nothing. Decision 2.
 *
 * The three that *do* appear each have a different reason:
 *
 * | Engine | Why a command exists |
 * |---|---|
 * | OpenCode | Genuinely install-or-not: the binary is spawned from `PATH`, and without it the engine cannot run |
 * | Claude Code | The native `claude` is **preferred** over the bundled binary, and is the only way to reach `claude auth login` |
 * | Codex | The engine already runs. The CLI is needed *only* so `codex login` exists as a command — see {@link CODEX_LOGIN_SCOPE} |
 *
 * ## Every string here is an instruction
 *
 * A copyable command asserts "run this and you will be better off". Where that
 * is conditional, the condition is stated in `caveats` rather than detected —
 * Phase 2 does not probe the npm prefix or the platform, so it must not imply it
 * did. Phase 3 detects the writability case and degrades *back to this text*.
 *
 * @see plans/engine-availability-and-install.md — Phase 2, Decisions 4 and 5
 */
import type { EngineInstallGuidance, EngineInstallRecipe, EngineStatus } from "shared/types/index.js";

// ── Package literals ────────────────────────────────────────────────
//
// Written once, here, and referenced by identifier everywhere below so a recipe
// cannot name a package the allowlist does not.

const CLAUDE_CODE_CLI_PACKAGE = "@anthropic-ai/claude-code";
const OPENCODE_PACKAGE = "opencode-ai";
const CODEX_CLI_PACKAGE = "@openai/codex";

/**
 * The closed set of packages Callboard will ever install globally.
 *
 * Phase 3's endpoint checks membership here before spawning anything. It is
 * derived from the recipes rather than maintained beside them, so the two cannot
 * drift — a package reachable by the installer but absent from this set is not
 * expressible.
 */
export const INSTALLABLE_PACKAGES: ReadonlySet<string> = new Set([CLAUDE_CODE_CLI_PACKAGE, OPENCODE_PACKAGE, CODEX_CLI_PACKAGE]);

// ── Shared caveats ──────────────────────────────────────────────────

/**
 * The two ways `npm install -g` succeeds at the terminal and still leaves
 * Callboard unable to find the binary.
 *
 * Neither is detected in Phase 2 — that is Phase 3's preflight — so both are
 * *stated*. A user on a system Node hits the first; a user on nvm running the
 * daemon under a different version hits the second, and in that case the install
 * genuinely worked and the engine genuinely stays missing, which is the most
 * confusing outcome this feature can produce.
 */
const NPM_GLOBAL_CAVEATS = Object.freeze([
  "Needs an npm global prefix you can write to. On a system-wide Node install this fails with EACCES until you point npm at a prefix you own (`npm config set prefix ~/.npm-global`) or install through your platform's package manager.",
  "Under nvm the global prefix belongs to the active Node version. Callboard finds the binary only if its daemon runs under that same version — check `node -v` in the terminal you install from against the Node running Callboard.",
] as const);

/** A `curl … | bash` installer is a bash script, and both of the ones here are POSIX-only. */
const SCRIPT_CAVEATS = Object.freeze([
  "macOS and Linux only — this is a bash script. On Windows, use the npm command above (or WSL).",
  "Callboard never runs this for you. Read the script before piping it to a shell, as you would any installer.",
] as const);

/**
 * What installing `@openai/codex` does, and — more importantly — what it does
 * not.
 *
 * Codex is the entry the Phase 0 review turned up: the engine needs **no**
 * install, because `@openai/codex-sdk` brings a platform binary with it. But
 * that binary lives inside Callboard's own `node_modules` and Callboard's `bin/`
 * exposes no passthrough, so it never lands on the user's `PATH` — which makes
 * `codex login` a command a clean-install user simply does not have, and the
 * ChatGPT-subscription auth path unreachable out of the box.
 *
 * So this recipe is scoped to *logging in*. Framing it as "install Codex" would
 * be wrong twice over: the engine is already installed, and chats keep running
 * the bundled copy after the global install regardless.
 */
const CODEX_LOGIN_SCOPE =
  "This installs the Codex CLI so that `codex login` exists as a command. It does not change which binary your chats run — Callboard keeps using the copy bundled with `@openai/codex-sdk` either way, and `codex login` simply writes the credentials it then reads.";

// ── The recipes ─────────────────────────────────────────────────────

/**
 * Every recipe, in the order a card should offer them: the npm path first
 * (the one Phase 3 can turn into a button), the vendor script second.
 */
export const ENGINE_INSTALL_RECIPES: readonly EngineInstallRecipe[] = Object.freeze([
  {
    engineId: "claude-code",
    method: "npm-global",
    label: "npm (global)",
    package: CLAUDE_CODE_CLI_PACKAGE,
    argv: Object.freeze(["npm", "install", "-g", CLAUDE_CODE_CLI_PACKAGE]),
    command: `npm install -g ${CLAUDE_CODE_CLI_PACKAGE}`,
    docsUrl: "https://docs.claude.com/en/docs/claude-code/setup",
    caveats: NPM_GLOBAL_CAVEATS,
  },
  {
    engineId: "claude-code",
    method: "script",
    label: "Anthropic's installer",
    command: "curl -fsSL https://claude.ai/install.sh | bash",
    docsUrl: "https://docs.claude.com/en/docs/claude-code/setup",
    caveats: SCRIPT_CAVEATS,
  },
  {
    engineId: "opencode",
    method: "npm-global",
    label: "npm (global)",
    package: OPENCODE_PACKAGE,
    argv: Object.freeze(["npm", "install", "-g", OPENCODE_PACKAGE]),
    command: `npm install -g ${OPENCODE_PACKAGE}`,
    docsUrl: "https://opencode.ai/docs/",
    caveats: NPM_GLOBAL_CAVEATS,
  },
  {
    engineId: "opencode",
    method: "script",
    label: "OpenCode's installer",
    command: "curl -fsSL https://opencode.ai/install | bash",
    docsUrl: "https://opencode.ai/docs/",
    caveats: SCRIPT_CAVEATS,
  },
  {
    engineId: "codex",
    method: "npm-global",
    label: "npm (global)",
    package: CODEX_CLI_PACKAGE,
    argv: Object.freeze(["npm", "install", "-g", CODEX_CLI_PACKAGE]),
    command: `npm install -g ${CODEX_CLI_PACKAGE}`,
    docsUrl: "https://developers.openai.com/codex/cli/",
    caveats: NPM_GLOBAL_CAVEATS,
  },
] as const satisfies readonly EngineInstallRecipe[]);

/** Every recipe registered for an engine id, in offer order. Empty for the bundled engines. */
export function recipesFor(engineId: string): EngineInstallRecipe[] {
  return ENGINE_INSTALL_RECIPES.filter((recipe) => recipe.engineId === engineId);
}

// ── When a card offers them ─────────────────────────────────────────

/**
 * Does this engine's state warrant showing a command, and what should it say?
 *
 * The bar is deliberately high, because the failure mode of getting it wrong is
 * the one Phase 1 shipped four times: telling a user to run something that would
 * not help them. Three gates, and each is an observed fact rather than a guess:
 *
 * - **OpenCode** — `installed === false` means `which opencode` came back empty
 *   and the engine cannot run. Unambiguous.
 * - **Claude Code** — two separate states. Neither binary present (the engine
 *   cannot run), or a bundled binary running with no native CLI *and* no
 *   credentials, where `claude auth login` is the fix and is not a command the
 *   user has. Credentials `"unknown"` does not qualify: that is the SDK failing
 *   to answer, not an observed absence, and nagging on it is the Bedrock defect
 *   again.
 * - **Codex** — installed by definition, so the only gate is auth, and only when
 *   it is observably absent (`configured === false`, never `"unknown"`).
 *
 * Everything else — a credentialed engine, a bundled runtime, an ACP vendor that
 * resolved on PATH — gets `undefined`, and the card renders no command block at
 * all.
 */
export function installGuidanceFor(engine: EngineStatus): EngineInstallGuidance | undefined {
  const recipes = recipesFor(engine.id);
  if (recipes.length === 0) return undefined;

  if (engine.id === "codex") {
    // Bundled and always runnable; the only thing an install buys is `codex login`.
    if (engine.credentials.configured !== false) return undefined;
    return {
      reason:
        "Callboard found no Codex credentials. Signing in with a ChatGPT subscription needs the `codex` CLI on your PATH, and Callboard's copy of the binary is nested inside its own `node_modules` — so `codex login` is not a command you have yet.",
      scope: CODEX_LOGIN_SCOPE,
      alternative: "Or skip the install entirely: switch the auth mode below to API key and paste an OpenAI key. No CLI is involved in that path.",
      recipes,
    };
  }

  if (engine.id === "claude-code") {
    const runtime = engine.runtime;
    const nativeOnPath = runtime.kind === "external-preferred" && Boolean(runtime.resolvedPath);

    if (!engine.installed) {
      return {
        reason:
          "Neither a native `claude` on your PATH nor a bundled binary for this platform — the Agent SDK ships its binary as an optional dependency, so `--omit=optional` or an unpublished platform leaves nothing to run. This engine cannot start until one of the two is present.",
        alternative: "Reinstalling Callboard without `--omit=optional` restores the bundled binary, if that is how it went missing.",
        recipes,
      };
    }

    if (!nativeOnPath && engine.credentials.configured === false) {
      return {
        reason:
          "Chats run on the binary bundled with the Agent SDK, which works — but Callboard found no account, and `claude auth login` needs a native `claude` on your PATH. The bundled copy is nested inside Callboard's `node_modules` and never lands there.",
        scope:
          "It also becomes the copy your chats run: a native `claude` on your PATH wins over the bundled binary, and it is the one you update yourself rather than waiting for a Callboard release.",
        alternative: "Or skip the install: set an API key or auth token under Authentication below, which authenticates chats without any CLI.",
        recipes,
      };
    }

    return undefined;
  }

  // ACP vendors — the one genuinely install-or-not row on the page.
  if (engine.installed) return undefined;
  const command = engine.runtime.kind === "external" ? engine.runtime.command : engine.id;
  return {
    reason: `No \`${command}\` on the PATH of the user running the Callboard daemon, so this engine cannot start. Callboard spawns the binary per turn; there is nothing bundled behind it.`,
    // `opencode auth login` is verified against the CLI's own help output. Any
    // future vendor gets the claim Callboard can make without having looked —
    // that installing is not signing in, and that ACP gives it no way to help.
    alternative:
      engine.id === "opencode"
        ? "Installing it is only half the job: run `opencode auth login` in your own terminal afterwards. ACP gives Callboard no way to hand an agent a key, and it never touches this CLI's credential store."
        : "Installing it is only half the job — sign in with the vendor's own CLI afterwards. ACP gives Callboard no way to hand an agent a key, and it never touches this CLI's credential store.",
    recipes,
  };
}
