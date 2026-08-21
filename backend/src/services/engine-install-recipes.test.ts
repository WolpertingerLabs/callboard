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
import { ENGINE_INSTALL_RECIPES, INSTALLABLE_PACKAGES, installGuidanceFor, recipesFor } from "./engine-install-recipes.js";

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

  it("states the ways a successful command still leaves the engine missing", () => {
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

  it("says nothing when a native claude is already on PATH", () => {
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
    expect(guidance).toBeUndefined();
  });

  it("says nothing to a credentialed user running the bundled binary", () => {
    // An API key, a gateway token, or a third-party backend (Bedrock, Vertex)
    // all authenticate without any CLI. Telling those users to install one is
    // the Phase 1 Bedrock defect with a command attached.
    expect(installGuidanceFor(claudeCode({ credentials: { configured: true, source: "bedrock" } }))).toBeUndefined();
  });

  it("says nothing when the SDK could not be asked whether an account exists", () => {
    // "unknown" is the SDK failing to answer, not an observed absence. Offering
    // an install on it is a claim about the user's machine made from an error.
    expect(installGuidanceFor(claudeCode({ credentials: { configured: "unknown" } }))).toBeUndefined();
  });
});
