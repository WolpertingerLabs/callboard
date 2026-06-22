// @vitest-environment jsdom
/**
 * UI test for the chat-card row redesign: the folder pill shows the last path
 * segment, and clicking it reveals the full path WITHOUT triggering the parent
 * card's onClick (so tapping the pill on mobile never opens the chat).
 *
 * The `../api` module is mocked so dismissSummon resolves without network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Chat } from "../api";
import ChatListItem from "./ChatListItem";

vi.mock("../api", () => ({
  dismissSummon: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FULL_PATH = "/home/cybil/projects/my-cool-repo";

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    folder: FULL_PATH,
    displayFolder: FULL_PATH,
    session_id: "sess-1",
    session_log_path: null,
    metadata: JSON.stringify({ title: "My Chat" }),
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-21T00:00:00.000Z",
    git_branch: "main",
    ...overrides,
  };
}

describe("ChatListItem folder pill", () => {
  it("renders the last path segment", () => {
    render(<ChatListItem chat={makeChat()} onClick={() => {}} onDelete={() => {}} />);
    expect(screen.getByText("my-cool-repo")).toBeTruthy();
  });

  it("clicking the pill reveals the full path and does not fire the card onClick", () => {
    const onClick = vi.fn();
    render(<ChatListItem chat={makeChat()} onClick={onClick} onDelete={() => {}} />);

    // Full path bubble is not shown initially.
    expect(screen.queryByText(FULL_PATH)).toBeNull();

    fireEvent.click(screen.getByText("my-cool-repo"));

    // Bubble now shows the full path...
    expect(screen.getByText(FULL_PATH)).toBeTruthy();
    // ...and the parent card's onClick was NOT called.
    expect(onClick).not.toHaveBeenCalled();
  });
});
