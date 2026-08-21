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

const base: EngineStatus = {
  id: "cline",
  label: "Cline",
  runtime: { kind: "bundled", package: "@cline/sdk" },
  installed: true,
  version: "0.0.69",
  credentials: { configured: false },
};

describe("the Runtime row", () => {
  it("says a bundled engine updates with Callboard, not that it was installed", () => {
    render(<EngineStatusCard engine={base} />);
    expect(screen.getByText("Runtime")).toBeTruthy();
    expect(screen.getByText(/updates when Callboard does/)).toBeTruthy();
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
  it("frames a bundled engine's newer release as something Callboard carries", () => {
    render(<EngineStatusCard engine={{ ...base, latestVersion: "0.0.77", updateAvailable: true }} />);
    // Never "update available" for a bundled engine: npm-installing a newer
    // @cline/sdk into Callboard's tree is how the adapter breaks.
    expect(screen.getByText(/updating Callboard picks it up/)).toBeTruthy();
    expect(screen.queryByText(/· update available/)).toBeNull();
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
});

describe("the Credentials row", () => {
  it("names the source when there is one", () => {
    render(<EngineStatusCard engine={{ ...base, credentials: { configured: true, source: "auth.json" } }} />);
    expect(screen.getByText("Configured", { exact: false })).toBeTruthy();
    expect(screen.getAllByText(/auth\.json/).length).toBeGreaterThan(0);
  });

  it("keeps the caveat visible when nothing is configured", () => {
    render(<EngineStatusCard engine={{ ...base, credentials: { configured: false, note: "Held by the CLI, never by Callboard." } }} />);
    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.getByText("Held by the CLI, never by Callboard.")).toBeTruthy();
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

  it("ambers an installed engine with no confirmed credentials", () => {
    // Amber rather than red: for an ACP vendor this is a question Callboard
    // cannot ask, not a fault.
    const dot = engineStatusDot({ ...base, credentials: { configured: false, note: "Held by the CLI." } });
    expect(dot.color).toBe("var(--warning)");
    expect(dot.label).toBe("Credentials not confirmed");
    expect(dot.title).toContain("Held by the CLI.");
  });

  it("keeps the long reason out of the card header, where Credentials already says it", () => {
    const note = "Held by the OpenCode CLI, never by Callboard.";
    render(<EngineStatusCard engine={{ ...base, credentials: { configured: false, note } }} />);
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
