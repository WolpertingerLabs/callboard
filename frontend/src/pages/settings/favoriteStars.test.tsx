// @vitest-environment jsdom
/**
 * The two settings pages that own a star.
 *
 * Both are covered in one file because the two things under test are the same
 * thing said twice: a favorites write that fails has to *say so*, and the
 * feature has to be discoverable from either list.
 *
 * The failure case matters because the rollback is deliberately silent — there
 * is no hand-rolled revert in `utils/favorites.ts`, the last confirmed list
 * simply stands again (that is what keeps a re-starred favorite at its original
 * index). So what the user sees is a star that fills and empties, which is
 * exactly what a misclick looks like. Nothing else on either page would tell
 * them the daemon refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { FavoriteLists, FavoritesDelta } from "../../api";

const getFavorites = vi.fn();
const patchFavorites = vi.fn();
const listCustomSkills = vi.fn();
const listJobs = vi.fn();
const listJobRuns = vi.fn();

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  getFavorites: () => getFavorites(),
  patchFavorites: (delta: FavoritesDelta) => patchFavorites(delta),
  listCustomSkills: () => listCustomSkills(),
  listJobs: () => listJobs(),
  listJobRuns: (...args: unknown[]) => listJobRuns(...args),
}));

/** The run panel does its own fetching and is not what is under test. */
vi.mock("../../components/JobRunPanel", () => ({
  default: () => <div>run panel</div>,
  JOB_RUN_STATUS_META: new Proxy({}, { get: () => ({ label: "", color: "var(--text-muted)" }) }),
}));

const lists = (skills: string[] = [], jobs: string[] = []): FavoriteLists => ({ favoriteSkills: skills, favoriteJobs: jobs });

/** Fresh modules, so the module-level favorites cache starts empty. */
async function load(page: "skills" | "jobs") {
  vi.resetModules();
  const mod = page === "skills" ? await import("./SkillsSettings") : await import("./JobsSettings");
  return mod.default;
}

beforeEach(() => {
  getFavorites.mockReset().mockResolvedValue(lists(["release-notes"], ["nightly"]));
  patchFavorites.mockReset().mockResolvedValue(lists());
  listCustomSkills.mockReset().mockResolvedValue([{ name: "release-notes", description: "", updatedAt: new Date().toISOString() }]);
  listJobs.mockReset().mockResolvedValue([{ id: "nightly", name: "Nightly bake", version: 1, steps: [], inputs: [] }]);
  listJobRuns.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

async function renderPage(page: "skills" | "jobs") {
  const Page = await load(page);
  render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>,
  );
}

describe("Settings → Skills", () => {
  it("reports a favorites write the daemon refused", async () => {
    patchFavorites.mockRejectedValue(new Error("boom"));
    await renderPage("skills");

    const star = await screen.findByRole("button", { name: 'Favorite skill "release-notes"' });
    await waitFor(() => expect((star as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(star);

    expect(await screen.findByText("Could not save that change — your favorites are unchanged.")).toBeTruthy();
  });

  it("says nothing when the write lands", async () => {
    await renderPage("skills");

    const star = await screen.findByRole("button", { name: 'Favorite skill "release-notes"' });
    await waitFor(() => expect((star as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(star);

    await waitFor(() => expect(patchFavorites).toHaveBeenCalled());
    expect(screen.queryByText(/Could not save that change/)).toBeNull();
  });
});

describe("Settings → Jobs", () => {
  it("reports a favorites write the daemon refused", async () => {
    patchFavorites.mockRejectedValue(new Error("boom"));
    await renderPage("jobs");

    const star = await screen.findByRole("button", { name: 'Favorite job "Nightly bake"' });
    await waitFor(() => expect((star as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(star);

    expect(await screen.findByText("Could not save that change — your favorites are unchanged.")).toBeTruthy();
  });

  it("says the star does something, the way the Skills tab does", async () => {
    // Skills has carried this sentence since the feature shipped; Jobs had no
    // equivalent, so half the feature was discoverable only from the other
    // half's tab.
    await renderPage("jobs");

    expect(await screen.findByText(/Star a job to pin it to the New Chat screen/)).toBeTruthy();
  });
});
