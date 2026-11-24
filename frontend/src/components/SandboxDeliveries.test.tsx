import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SandboxDeliveriesResponse } from "shared/types/index.js";

vi.mock("../api/sandboxDeliveries", () => ({
  sandboxDeliveriesClient: { list: vi.fn(), retryKept: vi.fn(), discardKept: vi.fn() },
}));
import { sandboxDeliveriesClient } from "../api/sandboxDeliveries";
import SandboxDeliveries from "./SandboxDeliveries";
import { ServeChatContext } from "../contexts/ServeChatContext";

afterEach(() => {
  cleanup();
  vi.mocked(sandboxDeliveriesClient.list).mockReset();
  vi.mocked(sandboxDeliveriesClient.retryKept).mockReset();
  vi.mocked(sandboxDeliveriesClient.discardKept).mockReset();
});

const PATH = "/home/u/.callboard/sandbox-deliverables/f-0123/chat-1/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/files/results.zip";
const response = (overrides: Partial<SandboxDeliveriesResponse> = {}): SandboxDeliveriesResponse => ({
  sessions: [
    {
      sessionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      mode: "managed",
      state: "complete",
      startedAt: 1,
      endedAt: 2,
      files: [
        {
          sessionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
          name: "results.zip",
          storedName: "results.zip",
          path: PATH,
          size: 2048,
          sha256: "0".repeat(64),
          deliveredAt: 2,
          mediaType: "file",
          mimeType: "application/zip",
        },
      ],
      refused: [{ name: "huge.iso", size: 100 * 1024 * 1024, reason: "too-large" }],
    },
  ],
  kept: [],
  ...overrides,
});

describe("SandboxDeliveries", () => {
  it("renders nothing when the chat has no deliverables", async () => {
    vi.mocked(sandboxDeliveriesClient.list).mockResolvedValue({ sessions: [], kept: [] });
    const { container } = render(<SandboxDeliveries chatId="chat-1" sandboxLive={false} />);
    await waitFor(() => expect(sandboxDeliveriesClient.list).toHaveBeenCalledWith("chat-1"));
    expect(container.textContent).toBe("");
  });

  it("groups delivered files as file cards under 'Delivered from Sandbox desktop', served for this chat only, and lists refusals", async () => {
    vi.mocked(sandboxDeliveriesClient.list).mockResolvedValue(response());
    render(
      <ServeChatContext.Provider value="chat-1">
        <SandboxDeliveries chatId="chat-1" sandboxLive={false} />
      </ServeChatContext.Provider>,
    );
    expect(await screen.findByRole("region", { name: "Delivered from Sandbox desktop" })).toBeTruthy();
    expect(screen.getByText("results.zip")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
      `/api/files/serve?path=${encodeURIComponent(PATH)}&download=1&chat=chat-1`,
    );
    expect(screen.getByText(/Not delivered: huge\.iso .*over the 64 MiB per-file limit/)).toBeTruthy();
  });

  it("a kept container says so clearly, and offers Retry export and Discard", async () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    vi.mocked(sandboxDeliveriesClient.list).mockResolvedValue(
      response({
        sessions: [{ ...response().sessions[0], state: "incomplete", problem: "1 file still being written", refused: [] }],
        kept: [{ sessionId, keptAt: Date.now(), expiresAt: Date.now() + 24 * 3_600_000, reason: "1 file still being written" }],
      }),
    );
    vi.mocked(sandboxDeliveriesClient.retryKept).mockResolvedValue({ outcome: "removed" });
    render(<SandboxDeliveries chatId="chat-1" sandboxLive={false} />);
    expect(await screen.findByText(/Kept for recovery\./)).toBeTruthy();
    expect(screen.getByText(/1 file still being written/)).toBeTruthy();
    expect(screen.getByText(/removed in 24 hours/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry export" }));
    await waitFor(() => expect(sandboxDeliveriesClient.retryKept).toHaveBeenCalledWith("chat-1", sessionId));
    expect(await screen.findByText("Every file was copied; the container is removed.")).toBeTruthy();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(sandboxDeliveriesClient.discardKept).toHaveBeenCalledWith("chat-1", sessionId));
  });

  it("says what was lost when a kept container was discarded", async () => {
    vi.mocked(sandboxDeliveriesClient.list).mockResolvedValue(
      response({ sessions: [{ ...response().sessions[0], files: [], refused: [], state: "incomplete", lost: "discarded" }] }),
    );
    render(<SandboxDeliveries chatId="chat-1" sandboxLive={false} />);
    expect(await screen.findByText(/discarded before every file was copied out/)).toBeTruthy();
  });
});
