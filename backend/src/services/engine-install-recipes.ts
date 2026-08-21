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
import type { EngineInstallCapability, EngineInstallGuidance, EngineInstallRecipe, EngineStatus } from "shared/types/index.js";

// ── Package literals ────────────────────────────────────────────────
//
// Written once, here, and referenced by identifier everywhere below so a recipe
// cannot name a package the allowlist does not.

const CLAUDE_CODE_CLI_PACKAGE = "@anthropic-ai/claude-code";
const OPENCODE_PACKAGE = "opencode-ai";
const CODEX_CLI_PACKAGE = "@openai/codex";

// {@link INSTALLABLE_PACKAGES} is derived from the recipes below rather than
// declared here — see its doc comment for why that distinction matters.

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

/**
 * What a `curl … | bash` installer does that the npm path does not.
 *
 * The second entry is the important one and it is stated **per script**, with
 * the real directory, because it is not a corner case — it is what these
 * scripts do by design, every time:
 *
 * - `https://opencode.ai/install` sets `INSTALL_DIR=$HOME/.opencode/bin`,
 *   `mkdir -p`s it, and appends `export PATH=$INSTALL_DIR:$PATH` to the user's
 *   shell rc.
 * - `https://claude.ai/install.sh` downloads to `$HOME/.claude/downloads` and
 *   then runs `<binary> install`, which lands the launcher in
 *   `$HOME/.local/bin` and wires up shell integration.
 *
 * Both verified by reading the live scripts. In both cases the directory is on
 * the user's *future* shells' PATH and not on the running daemon's — a
 * process's environment is fixed at exec — and for OpenCode the directory
 * usually did not exist when the daemon started, so it *cannot* have been
 * inherited. Recheck re-runs `which` in the daemon's environment, so it will
 * keep answering "not installed" until Callboard is restarted from a shell that
 * has been re-sourced. Telling someone to press Recheck without saying that is
 * the copy-block equivalent of a button that does nothing.
 */
const scriptCaveats = (installDir: string, command: string) =>
  Object.freeze([
    "macOS and Linux only — this is a bash script. On Windows, use the npm command above (or WSL).",
    `Installs to \`${installDir}\` and puts it on your PATH by editing your shell rc. That takes effect in new terminals, not in the already-running Callboard daemon — a process's PATH is fixed when it starts, and this directory may not have existed then. Recheck will not find this install: run \`callboard restart\` from a terminal where \`${command}\` works.`,
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
    visibleAfterRecheck: true,
    caveats: NPM_GLOBAL_CAVEATS,
  },
  {
    engineId: "claude-code",
    method: "script",
    label: "Anthropic's installer",
    command: "curl -fsSL https://claude.ai/install.sh | bash",
    docsUrl: "https://docs.claude.com/en/docs/claude-code/setup",
    visibleAfterRecheck: false,
    caveats: scriptCaveats("~/.local/bin", "claude"),
  },
  {
    engineId: "opencode",
    method: "npm-global",
    label: "npm (global)",
    package: OPENCODE_PACKAGE,
    argv: Object.freeze(["npm", "install", "-g", OPENCODE_PACKAGE]),
    command: `npm install -g ${OPENCODE_PACKAGE}`,
    docsUrl: "https://opencode.ai/docs/",
    visibleAfterRecheck: true,
    caveats: NPM_GLOBAL_CAVEATS,
  },
  {
    engineId: "opencode",
    method: "script",
    label: "OpenCode's installer",
    command: "curl -fsSL https://opencode.ai/install | bash",
    docsUrl: "https://opencode.ai/docs/",
    visibleAfterRecheck: false,
    caveats: scriptCaveats("~/.opencode/bin", "opencode"),
  },
  {
    engineId: "codex",
    method: "npm-global",
    label: "npm (global)",
    package: CODEX_CLI_PACKAGE,
    argv: Object.freeze(["npm", "install", "-g", CODEX_CLI_PACKAGE]),
    command: `npm install -g ${CODEX_CLI_PACKAGE}`,
    docsUrl: "https://developers.openai.com/codex/cli/",
    visibleAfterRecheck: true,
    caveats: NPM_GLOBAL_CAVEATS,
  },
] as const satisfies readonly EngineInstallRecipe[]);

/**
 * The closed set of packages Callboard will ever install globally.
 *
 * Phase 3's endpoint checks membership here before spawning anything, which
 * makes this the security argument for that endpoint — so it is **derived**
 * from the recipes rather than written beside them. The previous cut claimed
 * exactly that in a comment while being a hand-written literal, and the test
 * only checked recipes ⊆ allowlist, so a stray entry would have been spawnable
 * with nothing failing. `engine-install-recipes.test.ts` now checks both
 * directions; derivation makes one of them true by construction.
 */
export const INSTALLABLE_PACKAGES: ReadonlySet<string> = Object.freeze(
  new Set(ENGINE_INSTALL_RECIPES.filter((r) => r.method === "npm-global" && r.package).map((r) => r.package!)),
) as ReadonlySet<string>;

/** Every recipe registered for an engine id, in offer order. Empty for the bundled engines. */
export function recipesFor(engineId: string): EngineInstallRecipe[] {
  return ENGINE_INSTALL_RECIPES.filter((recipe) => recipe.engineId === engineId);
}

/**
 * The one recipe for `engineId` that Phase 3 is permitted to spawn, if any.
 *
 * **This function is the security argument for `POST /api/engines/:id/install`,
 * so the endpoint routes through it rather than around it.** An engine id off
 * the wire selects a recipe here; it is never interpolated into a command, and
 * nothing the caller sends reaches argv. Four conditions, all of them checked
 * against the registry above rather than against the request:
 *
 * 1. the recipe's `method` is `npm-global` — a `script` recipe can never be
 *    reached with an intent to execute, which is Decision 5 made structural
 *    rather than remembered;
 * 2. it carries a `package`, and that package is in {@link INSTALLABLE_PACKAGES}
 *    — which is *derived* from this same table, so the set cannot drift open;
 * 3. it carries an `argv` array whose last element **is** that package, so the
 *    thing spawned and the thing allowlisted are provably the same string;
 * 4. `visibleAfterRecheck` is true. A recipe flagged false installs somewhere a
 *    running daemon's PATH cannot reach, so a one-click install of it would
 *    report success and change nothing observable — a lie with a progress bar.
 *    No `npm-global` recipe is flagged false today; the check is here so that
 *    adding one does not silently become a button.
 *
 * Returns `undefined` for every bundled engine, every unknown id, and any recipe
 * that fails a condition. The caller's only correct response to `undefined` is a
 * refusal that points at the copy block.
 */
export function oneClickRecipeFor(engineId: string): EngineInstallRecipe | undefined {
  const recipe = recipesFor(engineId).find((r) => r.method === "npm-global");
  if (!recipe) return undefined;
  if (!recipe.package || !INSTALLABLE_PACKAGES.has(recipe.package)) return undefined;
  if (!recipe.argv || recipe.argv.length < 2) return undefined;
  if (recipe.argv[recipe.argv.length - 1] !== recipe.package) return undefined;
  if (!recipe.visibleAfterRecheck) return undefined;
  return recipe;
}

// ── When a card offers them ─────────────────────────────────────────

/**
 * What can this engine's user actually do, if anything?
 *
 * The bar is deliberately high, because the failure mode of getting it wrong is
 * the one Phase 1 shipped four times: telling a user to run something that
 * would not help them. Every gate below is an **observed** fact, and the
 * observation has to be as wide as the claim:
 *
 * - **OpenCode** — `installed === false` means `which opencode` came back empty
 *   and the engine cannot run. Unambiguous.
 * - **Claude Code** — the CLI counts as present if *either* lookup found one.
 *   `runtime.resolvedPath` is what the Agent SDK will run;
 *   {@link EngineStatus.userCliPath} is what the user can type. They differ
 *   routinely — `~/.local/bin/claude` is where this file's own script recipe
 *   installs, and a daemon that started before that was on its PATH sees only
 *   the second. Gating on the first alone told people to install a binary the
 *   About page was simultaneously reporting the version of.
 * - **Codex** — always installed, so the only gate is auth. But "you do not
 *   have `codex login`" is a claim about PATH, so it is now *checked* against
 *   `userCliPath` rather than assumed from the bundled layout. Without that,
 *   following this card's own recipe and pressing Recheck returned the very
 *   same "install it" block.
 *
 * Credentials `"unknown"` never qualifies anywhere: that is the SDK or the
 * protocol failing to answer, not an observed absence, and acting on it is the
 * Bedrock defect with a command attached.
 *
 * The result may carry **no recipes** — "you have the CLI, you just have not
 * logged in" is guidance with nothing to install. See
 * {@link EngineInstallGuidance}.
 *
 * ## What `capability` does, and what it deliberately cannot do
 *
 * Everything above gates on **engine state alone**, and that is load-bearing
 * for Decision 8 rather than incidental: {@link withOneClick} runs afterwards
 * and can only *add* a button or a refusal line, never remove a recipe. So no
 * value of `capability` — not a tunnelled client, not the setting switched off,
 * not a read-only npm prefix — can take the copyable command away. Omitting the
 * argument is the honest encoding of "install capability was never evaluated",
 * and leaves the Phase 2 shape untouched.
 */
export function installGuidanceFor(engine: EngineStatus, capability?: EngineInstallCapability): EngineInstallGuidance | undefined {
  const guidance = baseGuidanceFor(engine);
  return guidance ? withOneClick(engine.id, guidance, capability) : undefined;
}

/**
 * Attach Phase 3's button — or the one-line reason there is not one.
 *
 * Decision 8 in one function. The guidance handed in was decided entirely by
 * **engine state**, and this only ever *adds* to it: there is no branch here
 * that removes a recipe, empties the list, or replaces the block. Turning the
 * capability off anywhere therefore cannot make the copy-and-paste command
 * disappear — the worst it can do is leave the copy block exactly as Phase 2
 * shipped it, with a sentence saying why.
 *
 * `capability === undefined` means nobody evaluated it — an internal caller, a
 * test, a probe with no HTTP request behind it. That leaves both fields absent
 * rather than inventing a refusal, because "Callboard will not run this for you"
 * would be a claim about a decision that was never made.
 */
function withOneClick(engineId: string, guidance: EngineInstallGuidance, capability: EngineInstallCapability | undefined): EngineInstallGuidance {
  if (!capability) return guidance;

  // Nothing to install (the CLI is there, only a login is missing) — a button
  // would have nothing to run, and a refusal would answer a question nobody
  // asked. This is `recipes: []`, the state Phase 2 added deliberately.
  if (guidance.recipes.length === 0) return guidance;

  const recipe = oneClickRecipeFor(engineId);

  if (!recipe) {
    // Every recipe on offer is copy-only. No `npm-global` entry exists for this
    // engine — today that is unreachable (all three engines with recipes have
    // one), and it is handled anyway so that adding a script-only engine cannot
    // produce a card that silently has no button and no explanation.
    return {
      ...guidance,
      refusal: "Callboard has no install for this engine that it can run itself — the only path is the vendor's own script, and Callboard never pipes an installer into a shell for you. Copy it into a terminal.",
    };
  }

  if (!capability.oneClick) {
    return {
      ...guidance,
      refusal: capability.refusal ?? "Callboard cannot run this install itself on this machine. Copy the command into a terminal instead.",
    };
  }

  return {
    ...guidance,
    oneClick: {
      engineId,
      package: recipe.package!,
      command: recipe.command,
      ...(capability.note ? { note: capability.note } : {}),
    },
  };
}

function baseGuidanceFor(engine: EngineStatus): EngineInstallGuidance | undefined {
  const recipes = recipesFor(engine.id);
  if (recipes.length === 0) return undefined;

  if (engine.id === "codex") {
    // Bundled and always runnable; the only thing an install buys is `codex login`.
    if (engine.credentials.configured !== false) return undefined;

    if (engine.userCliPath) {
      // They already have the CLI — quite possibly because they followed the
      // recipe below a minute ago. Offering it again is the bug this branch
      // exists to prevent.
      return {
        reason: `No Codex credentials yet, but you already have the CLI at \`${engine.userCliPath}\` — so \`codex login\` is a command you can run right now. It writes to \`$CODEX_HOME/auth.json\`, which is where Callboard reads from.`,
        alternative: "Or skip the login: switch the auth mode below to API key and paste an OpenAI key.",
        recipes: [],
      };
    }

    return {
      reason:
        "Callboard found no Codex credentials, and no `codex` on the daemon's PATH. Signing in with a ChatGPT subscription needs that CLI — Callboard's copy of the binary is nested inside its own `node_modules`, so `codex login` is not a command you have yet.",
      scope: CODEX_LOGIN_SCOPE,
      alternative: "Or skip the install entirely: switch the auth mode below to API key and paste an OpenAI key. No CLI is involved in that path.",
      recipes,
    };
  }

  if (engine.id === "claude-code") {
    const runtime = engine.runtime;
    const sdkPath = runtime.kind === "external-preferred" ? runtime.resolvedPath : undefined;
    // Either lookup counts. `claude auth login` runs in the user's shell, and
    // does not care which of the two Callboard would hand to the SDK.
    const cliAnywhere = sdkPath ?? engine.userCliPath;

    if (!engine.installed) {
      return {
        reason:
          "Neither a native `claude` nor a bundled binary for this platform — the Agent SDK ships its binary as an optional dependency, so `--omit=optional` or an unpublished platform leaves nothing to run. This engine cannot start until one of the two is present.",
        alternative: "Reinstalling Callboard without `--omit=optional` restores the bundled binary, if that is how it went missing.",
        recipes,
      };
    }

    if (engine.credentials.configured !== false) return undefined;

    if (cliAnywhere) {
      // Installed somewhere findable. Whether the SDK would pick it up is a
      // different question — and one this block must not conflate, because the
      // action is the same either way: log in.
      return {
        reason: `Callboard found no account, but there is a \`claude\` at \`${cliAnywhere}\` — so \`claude auth login\` is a command you can run right now.${
          sdkPath ? "" : " Note that chats are still running the bundled binary: this copy is not on the PATH the daemon inherited, so the Agent SDK's own lookup does not see it."
        }`,
        alternative: "Or skip the login: set an API key or auth token under Authentication below, which authenticates chats without any CLI.",
        recipes: [],
      };
    }

    return {
      reason:
        "Chats run on the binary bundled with the Agent SDK, which works — but Callboard found no account, and `claude auth login` needs a native `claude` that Callboard can see. The bundled copy is nested inside Callboard's `node_modules` and never lands on a PATH.",
      scope:
        "It also becomes the copy your chats run: a native `claude` on the daemon's PATH wins over the bundled binary, and it is the one you update yourself rather than waiting for a Callboard release.",
      alternative: "Or skip the install: set an API key or auth token under Authentication below, which authenticates chats without any CLI.",
      recipes,
    };
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
