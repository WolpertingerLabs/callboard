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
  missingSkills: [],
  missingJobs: [],
  settled: true,
  jobsResolved: true,
  error: null,
  retry: vi.fn(),
  dropMissing: vi.fn(),
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

  it("names the favorite that no longer resolves instead of just counting it", () => {
    // Renaming a starred skill is the ordinary way here. The chip used to
    // vanish with no signal at all, which reads identically to "the star never
    // saved" — and a bare count is barely better, because the id it will not
    // name is the only thing that would let the user work out what happened.
    renderLaunchpad({ favorites: favorites({ skills: [SKILL], missingSkills: ["renamed-away"] }) });

    expect(screen.getByText(/1 pinned item no longer exists/)).toBeTruthy();
    expect(screen.getByText("renamed-away")).toBeTruthy();
  });

  it("pluralises the stale note, names both kinds, and shows it with nothing left to draw", () => {
    renderLaunchpad({ favorites: favorites({ missingSkills: ["renamed-away"], missingJobs: ["deleted-job"] }) });

    expect(screen.getByText(/2 pinned items no longer exist/)).toBeTruthy();
    expect(screen.getByText("renamed-away, deleted-job")).toBeTruthy();
  });

  it("gives its inline actions the tap-target floor too", () => {
    // 41×14 measured at 390px on the Unpin the note had just grown — a new
    // sub-floor target on the screen this PR raised everything else on.
    renderLaunchpad({ favorites: favorites({ error: "Could not reach the daemon.", missingSkills: ["renamed-away"] }) });

    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).style.minHeight).toBe("44px");
    expect((screen.getByRole("button", { name: "Unpin it" }) as HTMLButtonElement).style.minHeight).toBe("44px");
  });

  it("offers a way to un-pin them, because nothing else in the UI can", () => {
    // The skill exists only under its new name, so there is no row left in
    // Settings carrying a star to un-set: without this the note is permanent
    // and unactionable. It is a user action — the write path still never
    // prunes on its own.
    const dropMissing = vi.fn();
    renderLaunchpad({ favorites: favorites({ skills: [SKILL], missingSkills: ["renamed-away"], dropMissing }) });

    fireEvent.click(screen.getByRole("button", { name: "Unpin it" }));

    expect(dropMissing).toHaveBeenCalledTimes(1);
  });

  it("keeps the stale note in the error card", () => {
    // A catalog failing is exactly when the other side's favorites can be
    // stale; this branch dropped the note in the one case where both are true.
    renderLaunchpad({ favorites: favorites({ error: "Could not load your pinned skills.", missingJobs: ["deleted-job"] }) });

    expect(screen.getByText("Could not load your pinned skills.")).toBeTruthy();
    expect(screen.getByText(/1 pinned item no longer exists/)).toBeTruthy();
    expect(screen.getByText("deleted-job")).toBeTruthy();
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

  it("gives Manage one too — it is this card's only navigation", () => {
    // 43×14 measured at 390px, on the one control here that leaves the screen,
    // while every sibling took the floor.
    renderLaunchpad({ favorites: favorites({ skills: [SKILL] }) });

    expect((screen.getByRole("link", { name: "Manage" }) as HTMLAnchorElement).style.minHeight).toBe("44px");
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

  /**
   * The other half of "closes a form whose job stopped resolving": it must not
   * close one whose job is merely unreadable.
   *
   * Both of these drive the guard through a state where `jobs` is `[]` and the
   * job has not gone anywhere, which is the exact shape that used to destroy a
   * half-filled form. They are here because the guard's gate had no test at
   * all — deleting it left all seventeen launchpad tests green.
   */
  const withInputs = () => JOB({ inputs: [{ key: "target", label: "Target", required: true }] });

  const rerenderWith = (rerender: (ui: React.ReactElement) => void, next: Partial<ResolvedFavorites>) =>
    rerender(
      <MemoryRouter>
        <NewChatLaunchpad onInsertPrompt={vi.fn()} slashCommands={COMMANDS} onOpenCommands={vi.fn()} favorites={favorites(next)} />
      </MemoryRouter>,
    );

  it("keeps a half-filled form while the job list is being re-read", () => {
    const job = withInputs();
    const { rerender } = withJob(job);

    fireEvent.click(chip());
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: "v2.4.0" } });

    // `retry` blanks both catalogs on its way to refetching them.
    rerenderWith(rerender, { jobs: [], jobsResolved: false, settled: false });
    rerenderWith(rerender, { jobs: [job] });

    expect((screen.getByLabelText(/Target/) as HTMLInputElement).value).toBe("v2.4.0");
  });

  it("keeps it when the re-read FAILS, too", () => {
    // `settled` goes true with `jobs: []` on a failed catalog read, which fired
    // the guard and took the typed value with it. A job whose re-read failed
    // has gone exactly as far as one being re-read: nowhere.
    const job = withInputs();
    const { rerender } = withJob(job);

    fireEvent.click(chip());
    fireEvent.change(screen.getByLabelText(/Target/), { target: { value: "v2.4.0" } });

    // The card is the error card while this is true, so the form is off screen
    // either way — what is under test is whether its state survived to be
    // drawn again.
    rerenderWith(rerender, { jobs: [], jobsResolved: false, settled: true, error: "Could not load your pinned jobs." });
    rerenderWith(rerender, { jobs: [job] });

    expect((screen.getByLabelText(/Target/) as HTMLInputElement).value).toBe("v2.4.0");
  });

  it("closes on Escape", () => {
    // Cancel was the only exit from a panel sitting between the user and the
    // composer. Escape is the key they press without thinking.
    withJob();

    fireEvent.click(chip());
    expect(screen.getByRole("button", { name: "Run job" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("button", { name: "Run job" })).toBeNull();
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
