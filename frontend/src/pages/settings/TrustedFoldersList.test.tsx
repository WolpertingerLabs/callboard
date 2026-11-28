import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ list: vi.fn(), untrust: vi.fn() }));
vi.mock("../../api", () => ({
  listTrustedFolders: () => h.list(),
  untrustFolder: (p: string) => h.untrust(p),
}));
const { default: TrustedFoldersList } = await import("./TrustedFoldersList");
afterEach(cleanup);

it("lists trusted folders and removes one", async () => {
  h.list.mockResolvedValue([
    { path: "/a/repo", addedAt: "2026-01-01" },
    { path: "/b/repo", addedAt: "2026-01-02" },
  ]);
  h.untrust.mockResolvedValue(undefined);
  render(<TrustedFoldersList />);
  expect(await screen.findByText("/a/repo")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop trusting /a/repo" }));
  await waitFor(() => expect(h.untrust).toHaveBeenCalledWith("/a/repo"));
  await waitFor(() => expect(screen.queryByText("/a/repo")).toBeNull());
  expect(screen.getByText("/b/repo")).toBeTruthy();
});

it("says how to add one when there are none", async () => {
  h.list.mockResolvedValue([]);
  render(<TrustedFoldersList />);
  expect(await screen.findByText(/Trust a folder from the notice/)).toBeTruthy();
});
