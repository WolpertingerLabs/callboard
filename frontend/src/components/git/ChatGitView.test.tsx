/**
 * The Changes | PRs toggle at the top of a chat's git view. localStorage is
 * deliberately not mocked: the choice surviving a remount is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ChatGitView from "./ChatGitView";

vi.mock("../GitDiffView", () => ({ default: ({ folder }: { folder: string }) => <div data-testid="diff">diff of {folder}</div> }));
vi.mock("./ChatPrsView", () => ({
  default: ({ folder, chatId }: { folder: string; chatId?: string }) => (
    <div data-testid="prs">
      prs of {folder} for {chatId ?? "new chat"}
    </div>
  ),
}));

const toggle = (name: "Changes" | "PRs") => screen.getByRole("button", { name });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("ChatGitView", () => {
  it("opens on Changes — the diff, exactly as before", () => {
    render(<ChatGitView folder="/repo" chatId="c1" />);
    expect(toggle("Changes").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("diff").textContent).toBe("diff of /repo");
    expect(screen.queryByTestId("prs")).toBeNull();
  });

  it("switches to the PRs half, passing the chat through, and back", () => {
    render(<ChatGitView folder="/repo" chatId="c1" />);
    fireEvent.click(toggle("PRs"));
    expect(toggle("PRs").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("prs").textContent).toBe("prs of /repo for c1");
    // Unmounted, not hidden: the diff does not keep loading behind it.
    expect(screen.queryByTestId("diff")).toBeNull();

    fireEvent.click(toggle("Changes"));
    expect(screen.getByTestId("diff")).toBeDefined();
    expect(screen.queryByTestId("prs")).toBeNull();
  });

  it("remembers the choice across a remount, for every chat", () => {
    render(<ChatGitView folder="/repo" chatId="c1" />);
    fireEvent.click(toggle("PRs"));
    cleanup();
    render(<ChatGitView folder="/other" chatId="c2" />);
    expect(toggle("PRs").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("prs").textContent).toBe("prs of /other for c2");
  });

  it("falls back to Changes on a stored value it does not know", () => {
    localStorage.setItem("claude-code-settings", JSON.stringify({ chatGitTab: "checks" }));
    render(<ChatGitView folder="/repo" />);
    expect(toggle("Changes").getAttribute("aria-pressed")).toBe("true");
  });

  it("says the folder is gone on Changes, without mounting the diff, and keeps PRs working", () => {
    render(<ChatGitView folder="/repo.gone" chatId="c1" folderGone />);
    expect(screen.getByTestId("folder-gone").textContent).toBe("This folder is no longer a git checkout.");
    expect(screen.queryByTestId("diff")).toBeNull();
    fireEvent.click(toggle("PRs"));
    expect(screen.getByTestId("prs").textContent).toBe("prs of /repo.gone for c1");
  });

  it("serves a new chat (no id) with just the folder", () => {
    localStorage.setItem("claude-code-settings", JSON.stringify({ chatGitTab: "prs" }));
    render(<ChatGitView folder="/repo" />);
    expect(screen.getByTestId("prs").textContent).toBe("prs of /repo for new chat");
  });
});
