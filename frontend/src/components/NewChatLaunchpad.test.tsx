// @vitest-environment jsdom
/**
 * The launchpad decides its whole shape from ONE question — what resolved —
 * and these tests are mostly about the two ways that used to be asked wrong.
 *
 * It gated the card on the favorite *ids* and the body on the resolved
 * entities, which produced a permanently empty "Quick start" header for anyone
 * whose favorites named a renamed skill (the settings doc-comment calls that
 * the normal case), and suppressed the commands fallback for them forever.
 * And on the first new-chat screen of a browser session the un-loaded cache
 * made a user *with* favorites see the "nothing starred" fallback for a beat
 * before it swapped — a layout jump that also told them something false about
 * their own install.
 *
 * The job half is tested for the property that makes it safe: spawning is an
 * irreversible side effect, so the first click only opens a form and the
 * second is what starts anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NewChatLaunchpad from "./NewChatLaunchpad";
import type { ResolvedFavorites } from "../hooks/useResolvedFavorites";
import type { CustomSkillListItem, JobDefinition } from "../api";

const spawnJob = vi.fn();

vi.mock("../api", () => ({
  spawnJob: (...args: unknown[]) => spawnJob(...args),
}));

// The run panel does its own fetching and is not what is under test here.
vi.mock("./JobRunPanel", () => ({
  default: ({ runId }: { runId: string }) => <div>run panel {runId}</div>,
}));

const SKILL: CustomSkillListItem = { name: "release-notes", description: "Write release notes", updatedAt: new Date().toISOString() };

const JOB = (overrides: Partial<JobDefinition> = {}): JobDefinition =>
  ({
    id: "nightly",
    name: "Nightly bake",
    version: 1,
    steps: [{ id: "one", type: "agent", prompt: "go" }],
    ...overrides,
  }) as JobDefinition;

const favorites = (overrides: Partial<ResolvedFavorites> = {}): ResolvedFavorites => ({
  skills: [],
  jobs: [],
  missing: 0,
  settled: true,
  error: null,
  retry: vi.fn(),
  ...overrides,
});

const COMMANDS = ["compact", "clear"];

function renderLaunchpad(props: Partial<React.ComponentProps<typeof NewChatLaunchpad>> = {}) {
  const onInsertPrompt = vi.fn();
  const onOpenCommands = vi.fn();
  const view = render(
    <MemoryRouter>
      <NewChatLaunchpad
        onInsertPrompt={onInsertPrompt}
        slashCommands={COMMANDS}
        onOpenCommands={onOpenCommands}
        favorites={favorites()}
        {...props}
      />
    </MemoryRouter>,
  );
  return { ...view, onInsertPrompt, onOpenCommands };
}

beforeEach(() => {
  spawnJob.mockReset();
});

afterEach(cleanup);

describe("NewChatLaunchpad — what it renders", () => {
  it("renders nothing at all while unsettled", () => {
    // Not a skeleton and NOT the fallback: what is coming might be either the
    // Quick start card or the commands grid, and guessing wrong is the layout
    // jump this replaced.
    const { container } = renderLaunchpad({ favorites: favorites({ settled: false }) });

    expect(container.textContent).toBe("");
    expect(screen.queryByText("Available Commands")).toBeNull();
  });

  it("does not flash the fallback for a user who has favorites", async () => {
    const { container, rerender } = renderLaunchpad({ favorites: favorites({ settled: false }) });
    expect(container.textContent).toBe("");

    rerender(
      <MemoryRouter>
        <NewChatLaunchpad onInsertPrompt={vi.fn()} slashCommands={COMMANDS} onOpenCommands={vi.fn()} favorites={favorites({ skills: [SKILL] })} />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Quick start")).toBeTruthy();
    expect(screen.queryByText("Available Commands")).toBeNull();
  });

  it("falls back to the commands grid when nothing resolves", () => {
    // The user HAS favorites — they just name skills that were renamed away.
    // The resolved lists are empty, so this is the "nothing to pin" screen, not
    // a Quick start header with nothing under it.
    renderLaunchpad({ favorites: favorites({ skills: [], jobs: [] }) });

    expect(screen.getByText("Available Commands")).toBeTruthy();
    expect(screen.queryByText("Quick start")).toBeNull();
    expect(screen.getByText("compact")).toBeTruthy();
  });

  it("still shows the star hint when there are no commands to fall back on", () => {
    // The empty case is the onboarding case. The hint used to live inside the
    // commands grid, so a fresh install — no favorites, no slash commands —
    // rendered nothing at all, and the one user who needs to be told this
    // feature exists was the one user who could not find out.
    renderLaunchpad({ slashCommands: [] });

    expect(screen.getByText(/Star a skill or job in/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings/skills");
    // And still not a Quick start header with nothing under it.
    expect(screen.queryByText("Quick start")).toBeNull();
    expect(screen.queryByText("Available Commands")).toBeNull();
  });

  it("reports a failed read with a retry rather than claiming nothing is starred", () => {
    const retry = vi.fn();
    renderLaunchpad({ favorites: favorites({ error: "Could not reach the daemon.", retry }) });

    expect(screen.getByText("Could not reach the daemon.")).toBeTruthy();
    expect(screen.queryByText("Available Commands")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps the half that loaded when the other half failed", () => {
    // One catalog answering and the other not is not a reason to hide the
    // chips that are real — the note says the list is incomplete.
    renderLaunchpad({ favorites: favorites({ skills: [SKILL], error: "Could not load jobs." }) });

    expect(screen.getByText("Quick start")).toBeTruthy();
    expect(screen.getByText("release-notes")).toBeTruthy();
    expect(screen.getByText("Could not load jobs.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("fills the composer from a skill chip without sending", () => {
    const { onInsertPrompt } = renderLaunchpad({ favorites: favorites({ skills: [SKILL] }) });

    fireEvent.click(screen.getByRole("button", { name: /release-notes/ }));

    expect(onInsertPrompt).toHaveBeenCalledWith("/callboard:release-notes ");
  });

  it("says when a favorite no longer resolves instead of just dropping it", () => {
    // Renaming a starred skill is the ordinary way here. The chip used to
    // vanish with no signal at all, which reads identically to "the star never
    // saved".
    renderLaunchpad({ favorites: favorites({ skills: [SKILL], missing: 1 }) });

    expect(screen.getByText("1 pinned item no longer exists.")).toBeTruthy();
  });

  it("pluralises the stale note and shows it with nothing left to draw", () => {
    renderLaunchpad({ favorites: favorites({ missing: 2 }) });

    expect(screen.getByText("2 pinned items no longer exist.")).toBeTruthy();
  });

  it("points Manage at the tab holding what was actually starred", () => {
    const manage = () => screen.getByRole("link", { name: "Manage" }).getAttribute("href");

    const { unmount } = renderLaunchpad({ favorites: favorites({ jobs: [JOB()] }) });
    expect(manage()).toBe("/settings/jobs");
    unmount();

    renderLaunchpad({ favorites: favorites({ skills: [SKILL], jobs: [JOB()] }) });
    expect(manage()).toBe("/settings/skills");
  });

  it("gives its chips a thumb-sized tap target", () => {
    // 33px measured on a 390px-wide phone, against the 44px both platform
    // guidelines ask for. The new-chat screen is reached over the tunnel as
    // often as from a desk.
    renderLaunchpad({ favorites: favorites({ skills: [SKILL], jobs: [JOB()] }) });

    expect((screen.getByRole("button", { name: /release-notes/ }) as HTMLButtonElement).style.minHeight).toBe("44px");
    expect((screen.getByRole("button", { name: /Nightly bake/ }) as HTMLButtonElement).style.minHeight).toBe("44px");
  });
});

describe("NewChatLaunchpad — spawning a job", () => {
  const withJob = (job = JOB()) => renderLaunchpad({ favorites: favorites({ jobs: [job] }) });

  const chip = () => screen.getByRole("button", { name: /Nightly bake/ });

  it("needs a second click — the chip only opens the form", () => {
    withJob();

    expect(chip().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chip());

    expect(chip().getAttribute("aria-expanded")).toBe("true");
    expect(spawnJob).not.toHaveBeenCalled();
    // The disclosure names the panel it opened.
    expect(document.getElementById(chip().getAttribute("aria-controls")!)).toBeTruthy();
  });

  it("spawns once, on the second click, and hands over to the run panel", async () => {
    spawnJob.mockResolvedValue({ runId: "run-1" });
    withJob();

    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("button", { name: "Run job" }));

    await waitFor(() => expect(spawnJob).toHaveBeenCalledTimes(1));
    expect(spawnJob).toHaveBeenCalledWith("nightly", {});
    expect(await screen.findByText("run panel run-1")).toBeTruthy();
  });

  it("keeps Run job disabled until a required input is filled", async () => {
    withJob(JOB({ inputs: [{ key: "target", label: "Target", required: true }] }));

    fireEvent.click(chip());
    const run = screen.getByRole("button", { name: "Run job" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);

    fireEvent.click(run);
    expect(spawnJob).not.toHaveBeenCalled();

    // Whitespace is not a value.
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Run job" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: "main" } });
    expect((screen.getByRole("button", { name: "Run job" }) as HTMLButtonElement).disabled).toBe(false);

    spawnJob.mockResolvedValue({ runId: "run-2" });
    fireEvent.click(screen.getByRole("button", { name: "Run job" }));
    await waitFor(() => expect(spawnJob).toHaveBeenCalledWith("nightly", { target: "main" }));
  });

  it("makes the blocked Run job button look blocked, and names the empty field", () => {
    // It computed `disabled` correctly all along and styled on `spawning`
    // only, so the primary CTA of an irreversible action rendered at full
    // accent with a pointer cursor while refusing every click.
    withJob(
      JOB({
        inputs: [
          { key: "target", label: "Target", required: true },
          { key: "tag", label: "Tag", required: true },
          { key: "note", label: "Note" },
        ],
      }),
    );

    fireEvent.click(chip());
    const run = () => screen.getByRole("button", { name: "Run job" }) as HTMLButtonElement;

    expect(run().style.background).toBe("var(--border)");
    expect(run().style.cursor).toBe("not-allowed");
    expect(run().getAttribute("title")).toBe("Fill in Target and Tag to continue.");
    expect(screen.getByText("Fill in Target and Tag to continue.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: "main" } });
    expect(run().getAttribute("title")).toBe("Fill in Tag to continue.");

    fireEvent.change(screen.getByLabelText(/Tag/), { target: { value: "v2" } });
    expect(run().style.background).toBe("var(--accent)");
    expect(run().style.cursor).toBe("pointer");
    expect(run().getAttribute("title")).toBeNull();
    expect(screen.queryByText(/Fill in/)).toBeNull();
  });

  it("closes an open form whose job stopped resolving", () => {
    const job = JOB();
    const { rerender } = withJob(job);

    fireEvent.click(chip());
    expect(screen.getByRole("button", { name: "Run job" })).toBeTruthy();

    // Unstarred in Settings in another tab, or deleted outright.
    rerender(
      <MemoryRouter>
        <NewChatLaunchpad onInsertPrompt={vi.fn()} slashCommands={COMMANDS} onOpenCommands={vi.fn()} favorites={favorites({ skills: [SKILL] })} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: "Run job" })).toBeNull();

    // And the form state went with it: re-starring and re-opening must not
    // bring back a half-filled form for a job the user had moved on from.
    rerender(
      <MemoryRouter>
        <NewChatLaunchpad onInsertPrompt={vi.fn()} slashCommands={COMMANDS} onOpenCommands={vi.fn()} favorites={favorites({ jobs: [job] })} />
      </MemoryRouter>,
    );
    expect(chip().getAttribute("aria-expanded")).toBe("false");
  });

  it("shows a spawn failure in the form and stays put", async () => {
    spawnJob.mockRejectedValue(new Error("no such job"));
    withJob();

    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("button", { name: "Run job" }));

    expect(await screen.findByText("no such job")).toBeTruthy();
    expect(screen.queryByText(/run panel/)).toBeNull();
  });
});
