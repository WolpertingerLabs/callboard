// @vitest-environment jsdom
/**
 * The update banner's states, and the two things none of them may do.
 *
 * **The copy-and-paste command is never removed.** It is what this banner was
 * before there was a button and what it degrades back to whenever Callboard
 * cannot act for itself, so every case below asserts it is still on screen —
 * including the failures, where it is the only action left.
 *
 * **A zero exit is not a success message.** The reducer is driven event by event
 * to pin the phase boundaries: npm finishing is `verifying`, the daemon naming
 * the version it wrote is `restarting`, and nothing before the poll may say the
 * new version is running.
 *
 * Prop-driven, like `EngineStatusCard.test.tsx`: the states that matter here
 * include ones a real daemon reaches only by stopping mid-restart, and those are
 * exactly the ones a rendering test should not need a daemon for.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { UpdateBannerView, reduceSelfUpdateEvent, type SelfUpdateRunState } from "./UpdateBanner";
import type { SelfUpdateEvent } from "../../api";

afterEach(cleanup);

const COMMAND = "npm install -g @wolpertingerlabs/callboard";

const idle: SelfUpdateRunState = { phase: "installing", command: COMMAND, fromVersion: "1.0.0", lines: [] };

function renderBanner(props: Partial<React.ComponentProps<typeof UpdateBannerView>> = {}) {
  return render(
    <UpdateBannerView
      currentVersion="1.0.0"
      latestVersion="1.1.0"
      command={COMMAND}
      capability={{ oneClick: true }}
      run={null}
      onUpdate={() => undefined}
      {...props}
    />,
  );
}

describe("the idle banner", () => {
  it("names both versions and offers the button", () => {
    renderBanner();
    expect(screen.getByText(/v1\.0\.0 → v1\.1\.0/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download latest & restart/ })).toBeTruthy();
  });

  it("keeps the copy-and-paste command even when it has a button", () => {
    renderBanner();
    expect(screen.getByText(COMMAND)).toBeTruthy();
  });

  it("renders a survivable capability note beside the button", () => {
    renderBanner({ capability: { oneClick: true, note: "Callboard's Node is nvm-managed (`/home/u/.nvm/node`)." } });
    expect(screen.getByText(/nvm-managed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download latest & restart/ })).toBeTruthy();
  });
});

describe("the refused banner", () => {
  it("offers no button and says why, under the command it can still copy", () => {
    renderBanner({
      capability: {
        oneClick: false,
        code: "not-global-install",
        refusal: "This Callboard is running from `/home/u/src/callboard`, which is not npm's global copy.",
      },
    });
    expect(screen.queryByRole("button", { name: /Download latest & restart/ })).toBeNull();
    expect(screen.getByText(/is not npm's global copy/)).toBeTruthy();
    expect(screen.getByText(COMMAND)).toBeTruthy();
  });

  it("shows the command while the capability is still unknown", () => {
    // The first frame, before `GET /api/self-update` has answered. A banner that
    // waited would be showing less than the one it replaced.
    renderBanner({ capability: undefined });
    expect(screen.getByText(COMMAND)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Download latest & restart/ })).toBeNull();
  });
});

describe("the state machine", () => {
  const apply = (state: SelfUpdateRunState, ...events: SelfUpdateEvent[]) => events.reduce(reduceSelfUpdateEvent, state);

  it("starts installing on the first frame", () => {
    const next = apply(idle, { type: "update_started", updateId: "u1", package: "p", command: COMMAND, fromVersion: "1.0.0", startedAt: "now" });
    expect(next).toMatchObject({ phase: "installing", command: COMMAND, fromVersion: "1.0.0" });
    expect(next.verdict).toBeUndefined();
  });

  it("collects output in order", () => {
    const next = apply(
      idle,
      { type: "update_output", stream: "stdout", line: "added 1 package" },
      { type: "update_output", stream: "stderr", line: "npm notice" },
    );
    expect(next.lines.map((l) => l.line)).toEqual(["added 1 package", "npm notice"]);
  });

  it("treats a zero exit as a question, not an answer", () => {
    const next = apply(idle, { type: "update_exit", updateId: "u1", ok: true, code: 0, signal: null, durationMs: 10 });
    expect(next.phase).toBe("verifying");
    // Nothing may claim an update happened here: npm exiting 0 means npm wrote
    // files, and which version it wrote is read off disk in the next frame.
    expect(next.verdict).toBeUndefined();
    expect(next.installedVersion).toBeUndefined();
  });

  it("ends on a non-zero exit with npm's own reason", () => {
    const next = apply(idle, { type: "update_exit", updateId: "u1", ok: false, code: 1, signal: null, durationMs: 10, refusal: "npm exited 1. Still running v1.0.0." });
    expect(next).toMatchObject({ phase: "done", verdict: { tone: "error", text: "npm exited 1. Still running v1.0.0." } });
  });

  it("moves to restarting — and still claims nothing — when the daemon says it is about to", () => {
    const next = apply(
      idle,
      { type: "update_verified", updateId: "u1", fromVersion: "1.0.0", installedVersion: "1.1.0", changed: true, summary: "v1.1.0 is installed. Restarting…", restart: "pending", rollbackCommand: "npm install -g p@1.0.0" },
      { type: "update_restarting", updateId: "u1", fromVersion: "1.0.0", installedVersion: "1.1.0", helper: "/g/bin/callboard.js", rollbackCommand: "npm install -g p@1.0.0" },
    );
    expect(next).toMatchObject({ phase: "restarting", installedVersion: "1.1.0", rollbackCommand: "npm install -g p@1.0.0" });
    expect(next.verdict).toBeUndefined();
  });

  it("ends on a refused restart, as a warning rather than a failure", () => {
    const next = apply(idle, {
      type: "update_verified",
      updateId: "u1",
      fromVersion: "1.0.0",
      installedVersion: "1.1.0",
      changed: true,
      summary: "installed but not restarted",
      restart: "refused",
      restartRefusal: "v1.1.0 is installed, but Callboard did not restart: 1 chat is still streaming.",
      rollbackCommand: "npm install -g p@1.0.0",
    });
    // Installed and not restarted is not a failure, and it is not what the
    // button offered either — which is exactly what `warn` means here.
    expect(next).toMatchObject({ phase: "done", verdict: { tone: "warn" } });
    expect(next.verdict!.text).toContain("still streaming");
  });

  it("ends on a skipped restart when npm had nothing newer", () => {
    const next = apply(idle, {
      type: "update_verified",
      updateId: "u1",
      fromVersion: "1.0.0",
      installedVersion: "1.0.0",
      changed: false,
      summary: "npm had nothing newer to fetch.",
      restart: "skipped",
      rollbackCommand: "npm install -g p@1.0.0",
    });
    expect(next).toMatchObject({ phase: "done", verdict: { tone: "warn", text: "npm had nothing newer to fetch." } });
  });

  it("ends loudly when the restart helper could not be started", () => {
    const next = apply(idle, {
      type: "update_restart_failed",
      updateId: "u1",
      refusal: "Callboard could not start the helper. Run `callboard restart`.",
      rollbackCommand: "npm install -g p@1.0.0",
    });
    expect(next).toMatchObject({ phase: "done", verdict: { tone: "error" }, rollbackCommand: "npm install -g p@1.0.0" });
  });
});

describe("the running banner", () => {
  it("disables the button and labels the phase", () => {
    renderBanner({ run: { ...idle, phase: "installing" } });
    const button = screen.getByRole("button", { name: /Installing…/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("labels the restart while it polls", () => {
    renderBanner({ run: { ...idle, phase: "restarting", progress: "Restarting into v1.1.0. Waiting for Callboard to answer again…" } });
    expect(screen.getByRole("button", { name: /Restarting…/ })).toBeTruthy();
    expect(screen.getByText(/Waiting for Callboard to answer again/)).toBeTruthy();
  });

  it("shows npm's output, and lets it be collapsed", () => {
    renderBanner({ run: { ...idle, lines: [{ stream: "stdout", line: "added 1 package" }] } });
    expect(screen.getByText(/added 1 package/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText(/added 1 package/)).toBeNull();
    expect(screen.getByRole("button", { name: /Show \(1 lines\)/ })).toBeTruthy();
  });

  it("still shows the command mid-run", () => {
    renderBanner({ run: { ...idle, phase: "restarting" } });
    expect(screen.getAllByText(COMMAND).length).toBeGreaterThan(0);
  });

  it("re-enables the button once the run is over", () => {
    renderBanner({ run: { ...idle, phase: "done", verdict: { tone: "ok", text: "Callboard is running v1.1.0." } } });
    const button = screen.getByRole("button", { name: /Download latest & restart/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.getByText(/Callboard is running v1\.1\.0/)).toBeTruthy();
  });

  it("presses the button once and not while it is busy", () => {
    const onUpdate = vi.fn();
    const { rerender } = renderBanner({ onUpdate });
    fireEvent.click(screen.getByRole("button", { name: /Download latest & restart/ }));
    expect(onUpdate).toHaveBeenCalledTimes(1);

    rerender(
      <UpdateBannerView currentVersion="1.0.0" latestVersion="1.1.0" command={COMMAND} capability={{ oneClick: true }} run={{ ...idle, phase: "installing" }} onUpdate={onUpdate} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Installing…/ }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
