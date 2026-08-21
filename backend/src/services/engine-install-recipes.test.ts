/**
 * `services/engine-install-recipes.ts` — the two things that make this registry
 * safe to have, and the three gates that decide whether a card shows one.
 *
 * The safety properties are structural, so they are asserted structurally: every
 * `npm-global` package is in the closed allowlist, every argv is a literal array
 * whose tail *is* that package, and no `script` recipe carries an argv at all —
 * which is what makes Decision 5 ("copy-only, forever") impossible to violate by
 * accident in Phase 3 rather than merely discouraged.
 *
 * The gating tests are the other half. Phase 1 shipped four defects of one kind
 * — the UI asserting something it could not know — and a copyable command is the
 * strongest assertion on the page. So each case here is "a state in which we
 * must NOT offer a command", written from the machine that would be lied to.
 */
import { describe, expect, it } from "vitest";
import type { EngineStatus } from "shared/types/index.js";
import { ENGINE_INSTALL_RECIPES, INSTALLABLE_PACKAGES, installGuidanceFor, oneClickRecipeFor, recipesFor } from "./engine-install-recipes.js";

const engine = (over: Partial<EngineStatus> & Pick<EngineStatus, "id">): EngineStatus => ({
  label: over.id,
  runtime: { kind: "bundled", package: "x" },
  installed: true,
  credentials: { configured: true },
  ...over,
});

const claudeCode = (over: Partial<EngineStatus> = {}): EngineStatus =>
  engine({
    id: "claude-code",
    runtime: { kind: "external-preferred", package: "@anthropic-ai/claude-code", command: "claude", fallbackPackage: "@anthropic-ai/claude-agent-sdk" },
    ...over,
  });

const opencode = (over: Partial<EngineStatus> = {}): EngineStatus =>
  engine({ id: "opencode", runtime: { kind: "external", command: "opencode" }, credentials: { configured: "unknown" }, ...over });

const codex = (over: Partial<EngineStatus> = {}): EngineStatus =>
  engine({ id: "codex", runtime: { kind: "bundled-overridable", package: "@openai/codex-sdk" }, ...over });

describe("the registry itself", () => {
  it("keeps every npm-global package inside the allowlist", () => {
    for (const recipe of ENGINE_INSTALL_RECIPES) {
      if (recipe.method !== "npm-global") continue;
      expect(recipe.package).toBeTruthy();
      expect(INSTALLABLE_PACKAGES.has(recipe.package!)).toBe(true);
    }
  });

  it("has no allowlist entry that no recipe asks for", () => {
    // The other direction, and the one that was missing. Phase 3 checks
    // membership in this set before spawning, so a stray entry is a package
    // Callboard would install on request with nothing in the UI naming it —
    // and the previous test suite could not have noticed, because it only
    // checked recipes ⊆ allowlist. The set is now derived, which makes this
    // true by construction; the assertion is here so that a future
    // hand-written literal fails instead of quietly re-opening the hole.
    const fromRecipes = new Set(ENGINE_INSTALL_RECIPES.filter((r) => r.method === "npm-global").map((r) => r.package));
    expect([...INSTALLABLE_PACKAGES].sort()).toEqual([...fromRecipes].sort());
  });

  it("names the allowlisted package as the literal last argv entry", () => {
    // Not `expect.stringContaining`: the point is that argv is a fixed array
    // with the package as its own element, so nothing about it can be assembled
    // from a request or reinterpreted by a shell.
    for (const recipe of ENGINE_INSTALL_RECIPES) {
      if (recipe.method !== "npm-global") continue;
      expect(recipe.argv).toEqual(["npm", "install", "-g", recipe.package]);
      expect(recipe.command).toBe(`npm install -g ${recipe.package}`);
    }
  });

  it("gives script recipes no argv at all", () => {
    // Decision 5, enforced by shape: with nothing to hand execFile, a `curl | bash`
    // recipe cannot become one-click in Phase 3 through an oversight.
    const scripts = ENGINE_INSTALL_RECIPES.filter((r) => r.method === "script");
    expect(scripts.length).toBeGreaterThan(0);
    for (const recipe of scripts) {
      expect(recipe.argv).toBeUndefined();
      expect(recipe.package).toBeUndefined();
    }
  });

  it("has no recipe at all for the bundled engines", () => {
    // A global install cannot reach Callboard's nested node_modules, so the
    // command would be an inert no-op — worse than no command, because the
    // version it reports would never move. Decision 2.
    expect(recipesFor("cline")).toEqual([]);
    expect(recipesFor("pi")).toEqual([]);
  });

  it("carries a docs link on every recipe", () => {
    for (const recipe of ENGINE_INSTALL_RECIPES) {
      expect(recipe.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it("states the ways a successful npm command still leaves the engine missing", () => {
    // Phase 2 does not detect a non-writable prefix or an nvm prefix belonging
    // to another Node. It must therefore not imply that it checked — and both
    // end in a command that exits 0 with nothing found.
    for (const recipe of ENGINE_INSTALL_RECIPES) {
      if (recipe.method !== "npm-global") continue;
      const caveats = (recipe.caveats ?? []).join(" ");
      expect(caveats).toContain("EACCES");
      expect(caveats).toContain("nvm");
    }
  });

  it("says where each vendor script installs, and that Recheck cannot see it", () => {
    // The previous cut asserted caveats only for `npm-global` — it opened with
    // `if (recipe.method !== "npm-global") continue`, so the script recipes'
    // caveats were covered by nothing at all. They were also the weaker copy:
    // npm-global got two careful notes about a failure that is occasional,
    // while the scripts, which fail this way *by design every time*, got none.
    //
    // Read off the live installers: opencode's sets
    // `INSTALL_DIR=$HOME/.opencode/bin` and edits the shell rc; Anthropic's runs
    // `<binary> install`, landing the launcher in `$HOME/.local/bin`. Neither
    // directory can be on a running daemon's PATH, which is fixed at exec.
    const dirs: Record<string, string> = { "claude-code": "~/.local/bin", opencode: "~/.opencode/bin" };
    const scripts = ENGINE_INSTALL_RECIPES.filter((r) => r.method === "script");
    expect(scripts.map((r) => r.engineId).sort()).toEqual(["claude-code", "opencode"]);
    for (const recipe of scripts) {
      const caveats = (recipe.caveats ?? []).join(" ");
      expect(caveats).toContain(dirs[recipe.engineId]);
      expect(caveats).toContain("PATH");
      expect(caveats).toContain("callboard restart");
      expect(caveats).toMatch(/macOS and Linux only/);
    }
  });

  it("marks exactly the npm recipes as things Recheck can see", () => {
    // The card's closing line is keyed off this, so a wrong value here is a
    // "press Recheck" instruction that can never come true.
    for (const recipe of ENGINE_INSTALL_RECIPES) {
      expect(recipe.visibleAfterRecheck).toBe(recipe.method === "npm-global");
    }
  });
});

describe("cline and pi — never", () => {
  it("offer nothing however far behind they are", () => {
    expect(installGuidanceFor(engine({ id: "cline", updateAvailable: true, version: "0.0.1", latestVersion: "9.9.9" }))).toBeUndefined();
    expect(installGuidanceFor(engine({ id: "pi", updateAvailable: true }))).toBeUndefined();
  });
});

describe("opencode — the one genuinely install-or-not engine", () => {
  it("offers both paths when the binary is not on PATH", () => {
    const guidance = installGuidanceFor(opencode({ installed: false }));
    expect(guidance?.recipes.map((r) => r.method)).toEqual(["npm-global", "script"]);
    expect(guidance?.reason).toContain("opencode");
  });

  it("says nothing once the binary resolves", () => {
    // Credentials stay "unknown" forever for an ACP vendor — ACP has no auth
    // introspection — so gating on anything but `installed` would leave an
    // install command on the card of a working, signed-in OpenCode.
    expect(installGuidanceFor(opencode({ installed: true }))).toBeUndefined();
  });
});

describe("codex — install to log in, not to run", () => {
  it("frames the recipe as making `codex login` reachable, not as installing the engine", () => {
    const guidance = installGuidanceFor(codex({ credentials: { configured: false } }));
    expect(guidance?.recipes).toHaveLength(1);
    expect(guidance?.recipes[0].package).toBe("@openai/codex");
    // The engine is already installed and stays on the bundled binary; a block
    // that read "install Codex" would be wrong on both counts.
    expect(guidance?.scope).toContain("does not change which binary your chats run");
    expect(guidance?.alternative).toContain("API key");
  });

  it("says nothing when Codex is already authenticated", () => {
    expect(installGuidanceFor(codex({ credentials: { configured: true, source: "auth.json" } }))).toBeUndefined();
  });

  it("says nothing when Callboard could not tell whether it is authenticated", () => {
    expect(installGuidanceFor(codex({ credentials: { configured: "unknown" } }))).toBeUndefined();
  });

  it("does not offer an install to someone who already has the CLI", () => {
    // The state the recipe itself creates: install `@openai/codex`, press
    // Recheck, and the previous cut handed back the very same "install it"
    // block — because the only gate was auth and nothing ever looked at PATH.
    const guidance = installGuidanceFor(codex({ credentials: { configured: false }, userCliPath: "/usr/local/bin/codex" }));
    expect(guidance?.recipes).toEqual([]);
    expect(guidance?.reason).toContain("/usr/local/bin/codex");
    expect(guidance?.reason).toContain("codex login");
    expect(guidance?.reason).not.toMatch(/not a command you have/);
  });

  it("still says the CLI is missing when it genuinely is", () => {
    const guidance = installGuidanceFor(codex({ credentials: { configured: false } }));
    expect(guidance?.recipes.map((r) => r.command)).toEqual(["npm install -g @openai/codex"]);
    expect(guidance?.reason).toContain("no `codex` on the daemon's PATH");
  });
});

describe("claude code — two states, and the ones in between", () => {
  it("offers the install when neither a native CLI nor a bundled binary exists", () => {
    const guidance = installGuidanceFor(claudeCode({ installed: false, credentials: { configured: true, source: "auth.json" } }));
    expect(guidance?.recipes.map((r) => r.method)).toEqual(["npm-global", "script"]);
    expect(guidance?.reason).toContain("cannot start");
  });

  it("offers the install when the bundled binary runs but there is no way to log in", () => {
    const guidance = installGuidanceFor(claudeCode({ installed: true, credentials: { configured: false } }));
    expect(guidance?.reason).toContain("claude auth login");
  });

  it("offers no install when a native claude is already on PATH, only the login", () => {
    const guidance = installGuidanceFor(
      claudeCode({
        runtime: {
          kind: "external-preferred",
          package: "@anthropic-ai/claude-code",
          command: "claude",
          resolvedPath: "/usr/local/bin/claude",
          fallbackPackage: "@anthropic-ai/claude-agent-sdk",
        },
        credentials: { configured: false },
      }),
    );
    expect(guidance?.recipes).toEqual([]);
    expect(guidance?.reason).toContain("claude auth login");
    // No "chats are running the bundled binary" caveat here — this copy IS the
    // one the SDK resolved, so appending it would invent a split that does not
    // exist on this machine.
    expect(guidance?.reason).not.toContain("bundled binary");
  });

  it("says nothing to a credentialed user running the bundled binary", () => {
    // An API key, a gateway token, or a third-party backend (Bedrock, Vertex)
    // all authenticate without any CLI. Telling those users to install one is
    // the Phase 1 Bedrock defect with a command attached.
    expect(installGuidanceFor(claudeCode({ credentials: { configured: true, source: "bedrock" } }))).toBeUndefined();
  });

  it("does not tell someone to install a claude the wider lookup already found", () => {
    // `getClaudeCodeExecutablePath()` sees the setting and `which claude`;
    // `getClaudeBinaryPath()` also sees `CLAUDE_BINARY` and `~/.local/bin` —
    // which is where this file's own script recipe installs. A daemon started
    // before that was on its PATH has the second and not the first, so gating
    // on `resolvedPath` alone printed "no native claude" on a card while the
    // About page reported that same binary's version.
    const guidance = installGuidanceFor(claudeCode({ credentials: { configured: false }, userCliPath: "/home/u/.local/bin/claude" }));
    expect(guidance?.recipes).toEqual([]);
    expect(guidance?.reason).toContain("/home/u/.local/bin/claude");
    expect(guidance?.reason).toContain("claude auth login");
    // And it explains the split rather than pretending the two lookups agree.
    expect(guidance?.reason).toContain("bundled binary");
  });

  it("offers the install only when neither lookup found a claude", () => {
    const guidance = installGuidanceFor(claudeCode({ credentials: { configured: false } }));
    expect(guidance?.recipes.map((r) => r.method)).toEqual(["npm-global", "script"]);
  });

  it("says nothing when the SDK could not be asked whether an account exists", () => {
    // "unknown" is the SDK failing to answer, not an observed absence. Offering
    // an install on it is a claim about the user's machine made from an error.
    expect(installGuidanceFor(claudeCode({ credentials: { configured: "unknown" } }))).toBeUndefined();
  });
});

describe("oneClickRecipeFor — the security argument, in both directions", () => {
  it("selects exactly the npm-global recipe for each engine that has one", () => {
    expect(oneClickRecipeFor("opencode")?.package).toBe("opencode-ai");
    expect(oneClickRecipeFor("claude-code")?.package).toBe("@anthropic-ai/claude-code");
    expect(oneClickRecipeFor("codex")?.package).toBe("@openai/codex");
  });

  it("never selects a script recipe, for any engine", () => {
    // Decision 5, from the spawn side. Both engines that have a `script` recipe
    // also have an npm one, so the interesting assertion is not that this
    // returns undefined but that what it returns is never the script.
    for (const engineId of new Set(ENGINE_INSTALL_RECIPES.map((r) => r.engineId))) {
      expect(oneClickRecipeFor(engineId)?.method).not.toBe("script");
    }
  });

  it("selects nothing for a bundled engine or an unknown id", () => {
    expect(oneClickRecipeFor("cline")).toBeUndefined();
    expect(oneClickRecipeFor("pi")).toBeUndefined();
    expect(oneClickRecipeFor("")).toBeUndefined();
    expect(oneClickRecipeFor("../../etc/passwd")).toBeUndefined();
    expect(oneClickRecipeFor("opencode; rm -rf /")).toBeUndefined();
  });

  it("only ever returns a recipe whose argv tail is an allowlisted package", () => {
    // The property the install endpoint relies on: the thing spawned and the
    // thing allowlisted are provably the same string, not merely related ones.
    for (const engineId of new Set(ENGINE_INSTALL_RECIPES.map((r) => r.engineId))) {
      const recipe = oneClickRecipeFor(engineId);
      if (!recipe) continue;
      expect(recipe.argv).toEqual(["npm", "install", "-g", recipe.package]);
      expect(INSTALLABLE_PACKAGES.has(recipe.package!)).toBe(true);
    }
  });

  it("covers every allowlisted package — nothing is installable that no engine offers", () => {
    const reachable = new Set(
      [...new Set(ENGINE_INSTALL_RECIPES.map((r) => r.engineId))].map((id) => oneClickRecipeFor(id)?.package).filter(Boolean) as string[],
    );
    expect([...reachable].sort()).toEqual([...INSTALLABLE_PACKAGES].sort());
  });
});

describe("the button, and the reason there is not one — Decision 8", () => {
  const missingOpencode = () => opencode({ installed: false });

  it("says nothing either way when nobody evaluated capability", () => {
    // Every internal caller. Inventing "Callboard will not run this for you"
    // from an unasked question is the same class of claim as an "installed ✓"
    // nothing checked.
    const guidance = installGuidanceFor(missingOpencode());
    expect(guidance?.oneClick).toBeUndefined();
    expect(guidance?.refusal).toBeUndefined();
  });

  it("offers the npm recipe as a button when capability permits", () => {
    const guidance = installGuidanceFor(missingOpencode(), { oneClick: true });
    expect(guidance?.oneClick).toEqual({ engineId: "opencode", package: "opencode-ai", command: "npm install -g opencode-ai" });
    expect(guidance?.refusal).toBeUndefined();
  });

  it("carries a survivable warning next to the button rather than withholding it", () => {
    // The nvm case. The daemon doing the install is the daemon that will look,
    // so it is a note; turning it into a refusal would remove a button that
    // works on the overwhelming majority of nvm machines.
    const guidance = installGuidanceFor(missingOpencode(), { oneClick: true, note: "nvm-managed" });
    expect(guidance?.oneClick?.note).toBe("nvm-managed");
  });

  it("keeps every recipe when the capability refuses, and adds the reason", () => {
    // The structural half of Decision 8: a refusal may only ever *add* a
    // sentence. If this ever starts emptying `recipes`, a refused user is left
    // with nothing to type, which is the state the decision forbids.
    const permitted = installGuidanceFor(missingOpencode(), { oneClick: true });
    const refused = installGuidanceFor(missingOpencode(), { oneClick: false, code: "not-local", refusal: "You are on the tunnel." });
    expect(refused?.recipes.map((r) => r.command)).toEqual(permitted?.recipes.map((r) => r.command));
    expect(refused?.recipes.length).toBeGreaterThan(0);
    expect(refused?.reason).toBe(permitted?.reason);
    expect(refused?.oneClick).toBeUndefined();
    expect(refused?.refusal).toBe("You are on the tunnel.");
  });

  it("still says something when a refusal arrives with no sentence attached", () => {
    const guidance = installGuidanceFor(missingOpencode(), { oneClick: false });
    expect(guidance?.refusal).toBeTruthy();
  });

  it("offers no button and no refusal when there is nothing to install", () => {
    // `recipes: []` — the CLI is already there and only a login is missing. A
    // refusal here would be answering a question the card never asked.
    const guidance = installGuidanceFor(codex({ credentials: { configured: false }, userCliPath: "/usr/local/bin/codex" }), { oneClick: true });
    expect(guidance?.recipes).toEqual([]);
    expect(guidance?.oneClick).toBeUndefined();
    expect(guidance?.refusal).toBeUndefined();
  });

  it("offers no button at all to an engine that is fine", () => {
    expect(installGuidanceFor(opencode({ installed: true }), { oneClick: true })).toBeUndefined();
    expect(installGuidanceFor(engine({ id: "cline", updateAvailable: true }), { oneClick: true })).toBeUndefined();
  });

  it("names the codex recipe as the button, not the script — there is no codex script", () => {
    const guidance = installGuidanceFor(codex({ credentials: { configured: false } }), { oneClick: true });
    expect(guidance?.oneClick?.package).toBe("@openai/codex");
  });

  it("points claude-code's button at the npm recipe while the installer script stays copy-only", () => {
    const guidance = installGuidanceFor(claudeCode({ credentials: { configured: false } }), { oneClick: true });
    expect(guidance?.oneClick?.package).toBe("@anthropic-ai/claude-code");
    // Both recipes still render; only one of them is a button.
    expect(guidance?.recipes.map((r) => r.method)).toEqual(["npm-global", "script"]);
  });
});
