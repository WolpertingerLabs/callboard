// @vitest-environment jsdom
/**
 * A chat that is itself a fork — or an original a continuation or compression
 * replaced — carries its role icon at the left of its sidebar row, the same
 * icon its tree row shows. Word-only roles stay off the row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Chat } from "../api";
import ChatListItem from "./ChatListItem";
import { markerLabel } from "./ForkPointMarker";

vi.mock("../api", () => ({ dismissSummon: vi.fn().mockResolvedValue(undefined) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => () => {} }));

afterEach(cleanup);

function makeChat(meta: Record<string, unknown>): Chat {
  return {
    id: "chat-1",
    folder: "/repo",
    displayFolder: "/repo",
    session_id: "sess-1",
    session_log_path: null,
    metadata: JSON.stringify({ title: "A chat", ...meta }),
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-21T00:00:00.000Z",
  } as Chat;
}

const renderRow = (meta: Record<string, unknown>) => render(<ChatListItem chat={makeChat(meta)} onClick={() => {}} onDelete={() => {}} />);

describe("sidebar row role icon", () => {
  it("shows the fork icon for a fork, before the title", () => {
    const { container } = renderRow({ chatRole: "fork", parentChatId: "p" });
    const icon = screen.getByRole("img", { name: "Fork" });
    expect(icon.querySelector("svg.lucide-git-fork")).not.toBeNull();
    // Left of the title in the row's title line.
    const line = icon.parentElement!;
    expect(line.firstElementChild).toBe(icon);
    expect(line.textContent).toContain("A chat");
    expect(container).toBeTruthy();
  });

  it("labels the originals a continuation or compression replaced", () => {
    renderRow({ chatRole: "superseded" });
    expect(screen.getByRole("img", { name: /replaced by a continuation/ })).toBeTruthy();
    cleanup();
    renderRow({ chatRole: "pre-compression" });
    expect(screen.getByRole("img", { name: /before compression/ })).toBeTruthy();
  });

  it("shows nothing for a root or a word-only role", () => {
    renderRow({});
    expect(screen.queryByRole("img")).toBeNull();
    cleanup();
    renderRow({ chatRole: "subagent" });
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("subagent")).toBeNull();
  });
});

describe("fork point marker label", () => {
  const n = (role: string) => ({
    chatId: role,
    title: null,
    role,
    provider: "claude-code",
    status: "stopped" as const,
    folder: "/",
    createdAt: "",
    updatedAt: "",
    children: [],
  });
  it("names a lone replaced original, counts forks otherwise", () => {
    expect(markerLabel([n("superseded")])).toBe("Original continues");
    expect(markerLabel([n("pre-compression")])).toBe("Uncompressed original");
    expect(markerLabel([n("fork")])).toBe("1 fork");
    expect(markerLabel([n("fork"), n("superseded")])).toBe("2 forks");
  });
});
