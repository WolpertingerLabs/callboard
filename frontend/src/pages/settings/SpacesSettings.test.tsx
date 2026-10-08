// @vitest-environment jsdom
/**
 * Settings → Spaces flows: creating the second space offers the sort sheet,
 * delete never strands the user (jobs count, a 409 brings up the picker),
 * reorder is one request, a blank name is refused out loud, the plugin/skill
 * restriction waits for its list and edits it by delta, and the editor
 * follows values saved elsewhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SpaceListItem } from "shared/types/space.js";
import * as api from "../../api";
import { testSpace } from "../../testing/spaceContext";
import SpacesSettings from "./SpacesSettings";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    listSpaces: vi.fn(),
    createSpace: vi.fn(),
    updateSpace: vi.fn(async () => ({})),
    deleteSpace: vi.fn(),
    reorderSpaces: vi.fn(async () => {}),
    getAppPlugins: vi.fn(),
    listCustomSkills: vi.fn(async () => []),
    getSpaceFolderGroups: vi.fn(async () => []),
    moveToSpace: vi.fn(async () => ({ movedRoots: [], chatCount: 0, failed: [] })),
  };
});
const session = vi.hoisted(() => ({ version: 0 }));
vi.mock("../../contexts/SessionContext", () => ({ useMetadataVersion: () => session.version }));

const m = vi.mocked(api);
let server: SpaceListItem[];

beforeEach(() => {
  server = [testSpace("default", "General", { chatCount: 3 }), testSpace("sp_work", "Work", { order: 1, chatCount: 0, jobCount: 1 })];
  m.listSpaces.mockImplementation(async () => server.map((s) => ({ ...s })));
  m.getAppPlugins.mockResolvedValue({ scanRoots: [], plugins: [{ id: "p1", enabled: true, manifest: { name: "slack" } } as any] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  session.version = 0;
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <SpacesSettings />
    </MemoryRouter>,
  );
const edit = async (name: string) => fireEvent.click(await screen.findByRole("button", { name: `Edit ${name}` }));

describe("SpacesSettings", () => {
  it("offers to sort existing chats when the second space is created, and adds rules by delta", async () => {
    server = [testSpace("default", "General")];
    m.createSpace.mockImplementation(async () => {
      server = [...server, testSpace("sp_new", "New", { order: 1 })];
      return server[1];
    });
    m.getSpaceFolderGroups.mockResolvedValue([{ displayFolder: "/repo", rootCount: 2, chatCount: 5, lastActivityAt: "2026-01-01T00:00:00Z" }]);
    renderPage();
    fireEvent.change(await screen.findByLabelText("New space name"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));
    const sheet = await screen.findByRole("dialog", { name: "Sort existing chats" });
    fireEvent.change(await within(sheet).findByLabelText("Space for /repo"), { target: { value: "sp_new" } });
    fireEvent.click(within(sheet).getByRole("checkbox"));
    fireEvent.click(within(sheet).getByRole("button", { name: "Move chats" }));
    await waitFor(() => expect(m.moveToSpace).toHaveBeenCalledWith("sp_new", { folder: "/repo", fromSpace: "default" }));
    expect(m.updateSpace).toHaveBeenCalledWith("sp_new", { folderRulesAdd: ["/repo"] });
  });

  it("a space holding only a job offers the move-to picker and sends moveTo", async () => {
    m.deleteSpace.mockResolvedValue({ movedChats: 0, movedJobs: 1 });
    renderPage();
    await edit("Work");
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    const dialog = screen.getByRole("dialog", { name: "Delete space" });
    expect(within(dialog).getByText(/It holds 1 job/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete space" }));
    await waitFor(() => expect(m.deleteSpace).toHaveBeenCalledWith("sp_work", "default"));
  });

  it("a 409 brings up the picker instead of a dead end, and the retry sends moveTo", async () => {
    server[1] = { ...server[1], jobCount: 0 };
    m.deleteSpace.mockRejectedValueOnce(new api.SpaceNotEmptyError("not empty", 2, 0)).mockResolvedValueOnce({ movedChats: 2, movedJobs: 0 });
    renderPage();
    await edit("Work");
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    const dialog = screen.getByRole("dialog", { name: "Delete space" });
    expect(within(dialog).getByText(/no chats or jobs/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete space" }));
    await within(dialog).findByLabelText("Move chats to");
    expect(m.deleteSpace).toHaveBeenLastCalledWith("sp_work", undefined);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete space" }));
    await waitFor(() => expect(m.deleteSpace).toHaveBeenLastCalledWith("sp_work", "default"));
  });

  it("reorders with one request carrying the whole new order", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Move Work up" }));
    await waitFor(() => expect(m.reorderSpaces).toHaveBeenCalledTimes(1));
    expect(m.reorderSpaces).toHaveBeenCalledWith(["sp_work", "default"]);
    expect(m.updateSpace).not.toHaveBeenCalled();
  });

  it("refuses a blank name out loud instead of silently keeping the old one", async () => {
    renderPage();
    await edit("Work");
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "  " } });
    fireEvent.blur(name);
    expect((await screen.findByText("A space needs a name.")).getAttribute("role")).toBe("alert");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(m.updateSpace).not.toHaveBeenCalled();
  });

  it("keeps 'Only selected' disabled until the plugin list loads, then edits it by delta", async () => {
    let resolvePlugins: (v: any) => void = () => {};
    m.getAppPlugins.mockReturnValue(new Promise((r) => (resolvePlugins = r)));
    server[1] = { ...server[1], agentScope: { plugins: ["p1"] } };
    renderPage();
    await edit("Work");
    const restrict = screen.getByRole("checkbox", { name: /Only selected plugins/ });
    expect((restrict as HTMLInputElement).disabled).toBe(true);
    resolvePlugins({ scanRoots: [], plugins: [{ id: "p1", enabled: true, manifest: { name: "slack" } }] });
    await waitFor(() => expect((restrict as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("checkbox", { name: "slack" }));
    await waitFor(() => expect(m.updateSpace).toHaveBeenCalledWith("sp_work", { agentScopeRemove: { plugins: ["p1"] } }));
  });

  it("surfaces a failed plugin list instead of an empty one", async () => {
    m.getAppPlugins.mockRejectedValue(new Error("boom"));
    renderPage();
    await edit("Work");
    expect((await screen.findByText("boom")).getAttribute("role")).toBe("alert");
  });

  it("follows a value saved elsewhere while the field is untouched", async () => {
    renderPage();
    await edit("Work");
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("");
    server[1] = { ...server[1], defaults: { model: "opus" } };
    // Any write reloads the page; here, the accent.
    fireEvent.click(screen.getByRole("button", { name: "Accent blue" }));
    await waitFor(() => expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("opus"));
  });

  it("counts on mount, but a metadata bump reloads WITHOUT counts and keeps the last numbers", async () => {
    server[0] = { ...server[0], chatCount: 7 };
    const view = renderPage();
    await screen.findByText("7 chats");
    expect(m.listSpaces).toHaveBeenLastCalledWith({ includeArchived: true, includeCounts: true });
    // An uncounted response reports 0; the page must not show that.
    m.listSpaces.mockImplementation(async () => server.map((sp) => ({ ...sp, chatCount: 0, jobCount: undefined })));
    session.version = 1;
    view.rerender(
      <MemoryRouter>
        <SpacesSettings />
      </MemoryRouter>,
    );
    await waitFor(() => expect(m.listSpaces).toHaveBeenLastCalledWith({ includeArchived: true, includeCounts: false }), { timeout: 2000 });
    expect(screen.getByText("7 chats")).toBeTruthy();
  });
});

