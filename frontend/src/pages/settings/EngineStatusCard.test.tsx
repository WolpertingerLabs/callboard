// @vitest-environment jsdom
/**
 * The engine status card, and specifically the three states it must never
 * collapse into one.
 *
 * The feature exists because "installed ✓/✗" is a lie for four of the five
 * engines — they ship inside the Callboard package. So the assertions here are
 * about what each runtime kind *says*: a bundled engine must not read as
 * something the user installed, and a bundled engine with a newer version on npm
 * must not read as something the user can go and install.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { EngineStatus } from "../../api";
import EngineStatusCard, { engineStatusDot } from "./EngineStatusCard";

afterEach(cleanup);

/** Cline: bundled and pinned to an exact version in Callboard's manifest. */
const base: EngineStatus = {
  id: "cline",
  label: "Cline",
  runtime: { kind: "bundled", package: "@cline/sdk", dependencyRange: "0.0.69", pinned: true },
  installed: true,
  version: "0.0.69",
  credentials: { configured: "unknown", note: "No key set here." },
};

/** Codex: bundled behind a caret, so a Callboard update really can move it. */
const ranged: EngineStatus = {
  ...base,
  id: "codex",
  label: "Codex",
  runtime: { kind: "bundled-overridable", package: "@openai/codex-sdk", dependencyRange: "^0.146.0", pinned: false },
  version: "0.146.0",
  credentials: { configured: true, source: "auth.json" },
};

describe("the Runtime row", () => {
  it("says a bundled engine is not something the user installed", () => {
    render(<EngineStatusCard engine={base} />);
    expect(screen.getByText("Runtime")).toBeTruthy();
    // The reason, from Decision 2: a global install cannot reach Callboard's
    // own node_modules, so it would be inert rather than merely unnecessary.
    expect(screen.getByText(/Nothing to install/)).toBeTruthy();
  });

  it("names the native CLI that won over the bundled binary", () => {
    render(
      <EngineStatusCard
        engine={{
          ...base,
          id: "claude-code",
          label: "Claude Code",
          runtime: {
            kind: "external-preferred",
            package: "@anthropic-ai/claude-code",
            command: "claude",
            resolvedPath: "/usr/local/bin/claude",
            fallbackPackage: "@anthropic-ai/claude-agent-sdk",
            fallbackVersion: "0.2.141",
          },
        }}
      />,
    );
    expect(screen.getByText("/usr/local/bin/claude")).toBeTruthy();
    expect(screen.getByText(/preferred over the bundled/)).toBeTruthy();
  });

  it("says which binary runs when there is no native install", () => {
    render(
      <EngineStatusCard
        engine={{
          ...base,
          id: "claude-code",
          label: "Claude Code",
          version: undefined,
          runtime: {
            kind: "external-preferred",
            package: "@anthropic-ai/claude-code",
            command: "claude",
            fallbackPackage: "@anthropic-ai/claude-agent-sdk",
            fallbackVersion: "0.2.141",
          },
        }}
      />,
    );
    expect(screen.getAllByText(/No native/).length).toBeGreaterThan(0);
    // Not "not installed": the bundled binary still runs the engine.
    expect(screen.getByText(/No native install to report a version for/)).toBeTruthy();
  });

  it("does not tell a user with the CLI on PATH to install it", () => {
    // The degraded path: the fallback built from /api/system-info knows the
    // binary is there but not where, and keying the sentence off `resolvedPath`
    // rendered "not found on PATH" over an installed CLI.
    render(<EngineStatusCard engine={{ ...base, id: "opencode", label: "OpenCode", installed: true, runtime: { kind: "external", command: "opencode" } }} />);
    expect(screen.getByText(/found on PATH/)).toBeTruthy();
    expect(screen.queryByText(/not found on PATH/)).toBeNull();
    expect(screen.queryByText(/Install it to enable/)).toBeNull();
  });

  it("says an engine with neither binary cannot run, rather than naming one that is absent", () => {
    render(
      <EngineStatusCard
        engine={{
          ...base,
          id: "claude-code",
          label: "Claude Code",
          installed: false,
          version: undefined,
          runtime: { kind: "external-preferred", package: "@anthropic-ai/claude-code", command: "claude", fallbackPackage: "@anthropic-ai/claude-agent-sdk" },
        }}
      />,
    );
    expect(screen.getByText(/cannot run until one of the two is installed/)).toBeTruthy();
  });

  it("tells an external engine's user to install it", () => {
    render(
      <EngineStatusCard
        engine={{ ...base, id: "opencode", label: "OpenCode", installed: false, version: undefined, runtime: { kind: "external", command: "opencode" } }}
      />,
    );
    expect(screen.getByText(/not found on PATH/)).toBeTruthy();
    // Header verdict plus the Version row, which has no version to show.
    expect(screen.getAllByText("Not installed")).toHaveLength(2);
  });
});

describe("the Latest row", () => {
  it("states a pinned engine's newer release as a fact, with no remedy attached", () => {
    // The bug this replaces: this row said "updating Callboard picks it up"
    // for @cline/sdk and @earendil-works/pi-coding-agent, both of which are
    // pinned to an exact version in Callboard's manifest. Updating Callboard
    // installs the same version until a maintainer moves the pin, so the old
    // copy promised an action that provably does nothing.
    render(<EngineStatusCard engine={{ ...base, latestVersion: "0.0.77", updateAvailable: true }} />);
    expect(screen.getByText(/newer than the version Callboard pins/)).toBeTruthy();
    // Twice: the installed Version row, and the pin the Latest row names.
    expect(screen.getAllByText("0.0.69").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/picks it up/)).toBeNull();
    expect(screen.queryByText(/· update available/)).toBeNull();
  });

  it("offers the remedy for a ranged dependency, where it is real", () => {
    render(<EngineStatusCard engine={{ ...ranged, latestVersion: "0.149.0", updateAvailable: true }} />);
    // ^0.146.0 really does resolve 0.149.0 on a fresh install, so saying so is
    // honest — this is the case the pinned wording was borrowed from.
    expect(screen.getByText(/can pick it up/)).toBeTruthy();
    expect(screen.getByText("^0.146.0")).toBeTruthy();
  });

  it("offers an update for an external engine, where the action is honest", () => {
    render(
      <EngineStatusCard
        engine={{
          ...base,
          id: "opencode",
          runtime: { kind: "external", command: "opencode", resolvedPath: "/usr/bin/opencode", package: "opencode-ai" },
          version: "1.0.0",
          latestVersion: "1.1.0",
          updateAvailable: true,
        }}
      />,
    );
    expect(screen.getByText(/· update available/)).toBeTruthy();
  });

  it("says the registry was unreachable rather than implying up-to-date", () => {
    render(<EngineStatusCard engine={{ ...base, latestVersion: undefined }} />);
    expect(screen.getByText(/npm registry could not be reached/)).toBeTruthy();
  });

  it("does not blame the registry for a package it never asked about", () => {
    // An external CLI with no npm distribution has no `package` on its runtime,
    // so nothing was ever looked up. Latent with one ACP preset shipped;
    // guaranteed the moment a second one lands without an npm package.
    render(
      <EngineStatusCard
        engine={{ ...base, id: "somecli", label: "SomeCLI", runtime: { kind: "external", command: "somecli", resolvedPath: "/usr/bin/somecli" } }}
      />,
    );
    expect(screen.getByText(/tracks no npm package/)).toBeTruthy();
    expect(screen.queryByText(/could not be reached/)).toBeNull();
  });

  it("ages a stale answer instead of asserting it in the present tense", () => {
    const checkedAt = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    render(
      <EngineStatusCard engine={{ ...base, latestVersion: "0.0.69", updateAvailable: false, latestVersionCheckedAt: checkedAt, latestVersionStale: true }} />,
    );
    expect(screen.getByText(/Last checked 3 days ago/)).toBeTruthy();
    // "up to date" is a present-tense claim, and nobody checked the present.
    expect(screen.queryByText(/up to date/)).toBeNull();
  });
});

describe("the Credentials row", () => {
  it("names the source when there is one", () => {
    render(<EngineStatusCard engine={{ ...base, credentials: { configured: true, source: "auth.json" } }} />);
    expect(screen.getByText("Configured", { exact: false })).toBeTruthy();
    expect(screen.getAllByText(/auth\.json/).length).toBeGreaterThan(0);
  });

  it("keeps the caveat visible when nothing is configured", () => {
    render(<EngineStatusCard engine={{ ...base, credentials: { configured: false, note: "Run `codex login` once in a terminal." } }} />);
    // Header verdict plus the Credentials row itself.
    expect(screen.getAllByText("Not configured")).toHaveLength(2);
    expect(screen.getByText("Run `codex login` once in a terminal.")).toBeTruthy();
  });

  it("says Callboard cannot tell rather than asserting a negative it cannot support", () => {
    // Reproduced live before this changed: a machine with a valid opencode
    // auth.json rendered "Not configured". "Not configured" is a claim about
    // the user's machine, and for an ACP vendor Callboard has no standing to
    // make it — it does not read other tools' credential stores.
    render(
      <EngineStatusCard
        engine={{
          ...base,
          id: "opencode",
          label: "OpenCode",
          runtime: { kind: "external", command: "opencode", resolvedPath: "/usr/bin/opencode", package: "opencode-ai" },
          credentials: { configured: "unknown", note: "Held by the OpenCode CLI, never by Callboard." },
        }}
      />,
    );
    expect(screen.getByText("Callboard cannot tell")).toBeTruthy();
    expect(screen.queryByText("Not configured")).toBeNull();
  });

  it("does not read the unknown state as configured", () => {
    // "unknown" is a truthy string, so a `configured ?` test would render this
    // as a green "Configured" — the dishonest ✓ arriving by type coercion.
    render(<EngineStatusCard engine={{ ...base, credentials: { configured: "unknown", source: "should not be shown" } }} />);
    expect(screen.queryByText(/Configured/)).toBeNull();
    expect(screen.queryByText(/should not be shown/)).toBeNull();
  });
});

describe("engineStatusDot", () => {
  it("greys out an engine that is not installed", () => {
    const dot = engineStatusDot({ ...base, installed: false, runtime: { kind: "external", command: "opencode" } });
    expect(dot.color).toBe("var(--text-muted)");
    expect(dot.label).toBe("Not installed");
    expect(dot.title).toContain("opencode");
  });

  it("greens an installed, credentialed engine and names the source in the tooltip", () => {
    const dot = engineStatusDot({ ...base, credentials: { configured: true, source: "auth.json" } });
    expect(dot.color).toBe("var(--success)");
    expect(dot.label).toBe("Ready");
    expect(dot.title).toContain("auth.json");
  });

  it("ambers an engine whose credentials Callboard cannot see", () => {
    // Amber rather than red: for an ACP vendor this is a question Callboard
    // cannot ask, not a fault.
    const dot = engineStatusDot({ ...base, credentials: { configured: "unknown", note: "Held by the CLI." } });
    expect(dot.color).toBe("var(--warning)");
    expect(dot.label).toBe("Credentials not confirmed");
    expect(dot.title).toContain("Held by the CLI.");
  });

  it("distinguishes an observed absence from an unobservable one", () => {
    const unknown = engineStatusDot({ ...base, credentials: { configured: "unknown" } });
    const absent = engineStatusDot({ ...base, credentials: { configured: false } });
    expect(unknown.label).toBe("Credentials not confirmed");
    expect(absent.label).toBe("Not configured");
  });

  it("never greens an engine on the strength of the unknown state", () => {
    // `"unknown"` is truthy, so a `credentials.configured ?` check here would
    // paint every ACP vendor green regardless of whether it is signed in.
    expect(engineStatusDot({ ...base, credentials: { configured: "unknown" } }).color).not.toBe("var(--success)");
  });

  it("keeps the long reason out of the card header, where Credentials already says it", () => {
    const note = "Held by the OpenCode CLI, never by Callboard.";
    render(<EngineStatusCard engine={{ ...base, credentials: { configured: "unknown", note } }} />);
    // Once, in the Credentials row — not again as a truncated header line.
    expect(screen.getAllByText(note)).toHaveLength(1);
    expect(screen.getByText("Credentials not confirmed")).toBeTruthy();
  });

  it("has a state for status that never arrived", () => {
    expect(engineStatusDot(undefined).color).toBe("var(--text-muted)");
  });
});

describe("before the status arrives", () => {
  it("says it is checking rather than rendering an empty verdict", () => {
    render(<EngineStatusCard engine={undefined} loading />);
    expect(screen.getByText(/Checking engine status/)).toBeTruthy();
  });
});
