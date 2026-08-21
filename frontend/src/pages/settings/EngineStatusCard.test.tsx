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
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { EngineInstallGuidance, EngineStatus } from "../../api";
import EngineStatusCard, { engineStatusDot } from "./EngineStatusCard";

afterEach(cleanup);

/**
 * The card renders a `<Link>` for the bundled "check for a Callboard update"
 * action, so every case needs a router in scope — including the ones that do not
 * reach that branch, since which branch renders is what several of them assert.
 */
const render = (ui: React.ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

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
    // Backtick spans render as <code>, so the note is split across elements —
    // the same treatment the install block below gives its prose.
    expect(screen.getByText("codex login").tagName).toBe("CODE");
    expect(screen.getByText(/once in a terminal/)).toBeTruthy();
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

describe("the install block — Phase 2's whole deliverable", () => {
  const guidance: EngineInstallGuidance = {
    reason: "No `opencode` on the PATH of the user running the Callboard daemon.",
    scope: "Installing it does not change which binary your chats run.",
    alternative: "Or set an API key on this tab.",
    recipes: [
      {
        engineId: "opencode",
        method: "npm-global",
        label: "npm (global)",
        package: "opencode-ai",
        argv: ["npm", "install", "-g", "opencode-ai"],
        command: "npm install -g opencode-ai",
        docsUrl: "https://opencode.ai/docs/",
        visibleAfterRecheck: true,
        caveats: ["Needs a writable npm global prefix."],
      },
      {
        engineId: "opencode",
        method: "script",
        label: "OpenCode's installer",
        command: "curl -fsSL https://opencode.ai/install | bash",
        docsUrl: "https://opencode.ai/docs/",
        visibleAfterRecheck: false,
        caveats: ["Installs to `~/.opencode/bin` — Recheck will not find this install; run `callboard restart`."],
      },
    ],
  };

  const missing: EngineStatus = {
    ...base,
    id: "opencode",
    label: "OpenCode",
    runtime: { kind: "external", command: "opencode" },
    installed: false,
    version: undefined,
    install: guidance,
  };

  it("shows every command, verbatim", () => {
    render(<EngineStatusCard engine={missing} />);
    expect(screen.getByText("npm install -g opencode-ai")).toBeTruthy();
    expect(screen.getByText("curl -fsSL https://opencode.ai/install | bash")).toBeTruthy();
  });

  it("says what to run, what it does not change, and what needs nothing installed", () => {
    render(<EngineStatusCard engine={missing} />);
    expect(screen.getByText(/on the PATH of the user running the Callboard daemon/)).toBeTruthy();
    expect(screen.getByText(/does not change which binary your chats run/)).toBeTruthy();
    expect(screen.getByText(/Or set an API key on this tab/)).toBeTruthy();
  });

  it("states the caveat rather than implying it was checked", () => {
    // Phase 2 does not probe the npm prefix. A command block is an instruction,
    // so the conditions under which it would not help are printed next to it.
    render(<EngineStatusCard engine={missing} />);
    expect(screen.getByText(/Needs a writable npm global prefix/)).toBeTruthy();
  });

  it("does not offer to run anything for the user", () => {
    render(<EngineStatusCard engine={missing} />);
    // Copy buttons only — there is no install action anywhere on this card, in
    // this phase or, for the `curl | bash` recipe, ever.
    expect(screen.getByText(/Callboard does not run it for you/)).toBeTruthy();
    for (const button of screen.queryAllByRole("button")) {
      expect(button.getAttribute("aria-label") ?? button.textContent ?? "").toMatch(/Copy|Recheck/);
    }
  });

  it("copies the command it displays", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<EngineStatusCard engine={missing} />);
    fireEvent.click(screen.getByLabelText("Copy: npm install -g opencode-ai"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("npm install -g opencode-ai"));
  });

  it("is absent entirely when the engine is fine", () => {
    render(<EngineStatusCard engine={{ ...missing, installed: true, install: undefined }} />);
    expect(screen.queryByText("What to run")).toBeNull();
  });
});

describe("a bundled engine that is behind", () => {
  const behind: EngineStatus = { ...base, latestVersion: "0.0.77", updateAvailable: true };

  it("gets a link to About and no install command at all", () => {
    // Decision 2, as corrected in #354: `npm i -g @cline/sdk@latest` cannot
    // reach Callboard's nested node_modules, so a button would be inert — and a
    // button whose version row never moves is worse than no button.
    render(<EngineStatusCard engine={behind} />);
    expect(screen.queryByText("What to run")).toBeNull();
    const link = screen.getByText("Check for a Callboard update").closest("a");
    expect(link?.getAttribute("href")).toBe("/settings/about");
  });

  it("does not promise a Callboard update would move a pinned dependency", () => {
    render(<EngineStatusCard engine={behind} />);
    expect(screen.getByText(/only a release that moves the pin changes it/)).toBeTruthy();
  });

  it("says nothing when the bundled engine is current", () => {
    render(<EngineStatusCard engine={{ ...base, latestVersion: "0.0.69", updateAvailable: false }} />);
    expect(screen.queryByText("What to do")).toBeNull();
  });
});

describe("Recheck", () => {
  it("calls the handler it was given", async () => {
    const onRecheck = vi.fn().mockResolvedValue(undefined);
    render(<EngineStatusCard engine={base} onRecheck={onRecheck} />);
    fireEvent.click(screen.getByText("Recheck"));
    await waitFor(() => expect(onRecheck).toHaveBeenCalledTimes(1));
  });

  it("reports a failure instead of implying the recheck happened", async () => {
    const onRecheck = vi.fn().mockRejectedValue(new Error("offline"));
    render(<EngineStatusCard engine={base} onRecheck={onRecheck} />);
    fireEvent.click(screen.getByText("Recheck"));
    await waitFor(() => expect(screen.getByText(/Recheck failed/)).toBeTruthy());
  });

  it("is not rendered when there is no handler", () => {
    render(<EngineStatusCard engine={base} />);
    expect(screen.queryByText("Recheck")).toBeNull();
  });
});

describe("guidance with nothing to install", () => {
  /** The Codex "you already have the CLI, just log in" shape. */
  const loginOnly: EngineStatus = {
    ...base,
    id: "codex",
    label: "Codex",
    runtime: { kind: "bundled-overridable", package: "@openai/codex-sdk" },
    credentials: { configured: false },
    userCliPath: "/usr/local/bin/codex",
    install: {
      reason: "No Codex credentials yet, but you already have the CLI at `/usr/local/bin/codex`.",
      alternative: "Or switch the auth mode below to API key.",
      recipes: [],
    },
  };

  it("says what to do rather than what to run", () => {
    render(<EngineStatusCard engine={loginOnly} />);
    expect(screen.getByText("What to do")).toBeTruthy();
    expect(screen.queryByText("What to run")).toBeNull();
  });

  it("offers no command to copy", () => {
    render(<EngineStatusCard engine={loginOnly} />);
    expect(screen.queryByText(/npm install -g/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Copy:/ })).toBeNull();
  });

  it("does not tell the user Callboard will not run a command that does not exist", () => {
    render(<EngineStatusCard engine={loginOnly} />);
    expect(screen.queryByText(/Callboard does not run it for you/)).toBeNull();
    // It still points at Recheck, because a login IS something Recheck sees now.
    expect(screen.getByText(/re-reads the credential/)).toBeTruthy();
  });
});

describe("what the card promises Recheck can see", () => {
  const withScript = (visibleAfterRecheck: boolean): EngineStatus => ({
    ...base,
    id: "opencode",
    label: "OpenCode",
    runtime: { kind: "external", command: "opencode" },
    installed: false,
    install: {
      reason: "No `opencode` on PATH.",
      recipes: [
        {
          engineId: "opencode",
          method: "script",
          label: "OpenCode's installer",
          command: "curl -fsSL https://opencode.ai/install | bash",
          docsUrl: "https://opencode.ai/docs/",
          visibleAfterRecheck,
        },
      ],
    },
  });

  it("does not tell you to press Recheck after a script install", () => {
    // Verified against the live installers: opencode's writes to
    // `~/.opencode/bin` and edits the shell rc, Anthropic's lands in
    // `~/.local/bin`. A running daemon's PATH is fixed at exec, so Recheck
    // cannot ever see either — telling someone to press it is a button that
    // does nothing, dressed as an instruction.
    render(<EngineStatusCard engine={withScript(false)} />);
    expect(screen.getByText(/Recheck will not see this/)).toBeTruthy();
    expect(screen.getByText(/callboard restart/)).toBeTruthy();
  });

  it("does tell you to press Recheck when the install lands somewhere it can see", () => {
    render(<EngineStatusCard engine={withScript(true)} />);
    expect(screen.getByText(/Afterwards press/)).toBeTruthy();
    expect(screen.queryByText(/Recheck will not see this/)).toBeNull();
  });
});

describe("Recheck, when the server did not actually probe", () => {
  it("says so rather than implying a fresh check", async () => {
    // The endpoint is rate-limited because it spawns synchronously. A coalesced
    // or throttled call returning silently would make the button claim work it
    // did not do.
    const onRecheck = vi.fn().mockResolvedValue({ probed: false, retryAfterMs: 6_000 });
    render(<EngineStatusCard engine={base} onRecheck={onRecheck} />);
    fireEvent.click(screen.getByText("Recheck"));
    await waitFor(() => expect(screen.getByText(/Checked moments ago/)).toBeTruthy());
  });

  it("stays quiet when it did probe", async () => {
    const onRecheck = vi.fn().mockResolvedValue({ probed: true });
    render(<EngineStatusCard engine={base} onRecheck={onRecheck} />);
    fireEvent.click(screen.getByText("Recheck"));
    await waitFor(() => expect(onRecheck).toHaveBeenCalled());
    expect(screen.queryByText(/Checked moments ago/)).toBeNull();
  });
});
