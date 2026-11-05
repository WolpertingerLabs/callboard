// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ previewChatCompression: vi.fn(), compressChat: vi.fn() }));
vi.mock("../api", () => api);

const { default: CompressChatModal } = await import("./CompressChatModal");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const TS = "2026-01-01T00:00:00.000Z";
const renderModal = (onDone = vi.fn(), onCancel = vi.fn()) => {
  render(<CompressChatModal chatId="c1" timestamp={TS} direction="before" onCancel={onCancel} onDone={onDone} />);
  return { onDone, onCancel };
};

describe("CompressChatModal", () => {
  it("fetches the summary, lets the user edit it, and commits the edited text", async () => {
    api.previewChatCompression.mockResolvedValue({ summary: "model summary", chunks: 1, provider: "claude-code" });
    const result = { chat: { id: "new" }, original: null };
    api.compressChat.mockResolvedValue(result);
    const { onDone } = renderModal();

    expect(screen.getByRole("status").textContent).toMatch(/Summarising/);
    expect(api.previewChatCompression).toHaveBeenCalledWith("c1", TS, "before", expect.any(AbortSignal));
    const box = (await screen.findByLabelText(/Summary/)) as HTMLTextAreaElement;
    expect(box.value).toBe("model summary");

    fireEvent.change(box, { target: { value: "my edited summary" } });
    fireEvent.click(screen.getByRole("button", { name: "Compress" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(result));
    expect(api.compressChat).toHaveBeenCalledWith("c1", TS, "before", "my edited summary");
  });

  it("shows a failed preview and retries it", async () => {
    api.previewChatCompression
      .mockRejectedValueOnce(new Error("model unavailable"))
      .mockResolvedValueOnce({ summary: "second try", chunks: 1, provider: "codex" });
    renderModal();
    expect((await screen.findByRole("alert")).textContent).toContain("model unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(((await screen.findByDisplayValue("second try")) as HTMLTextAreaElement).value).toBe("second try");
    expect(api.previewChatCompression).toHaveBeenCalledTimes(2);
  });

  it("will not commit an empty summary, and cancels the preview when closed", async () => {
    let signal: AbortSignal | undefined;
    api.previewChatCompression.mockImplementation((_id, _ts, _dir, s: AbortSignal) => {
      signal = s;
      return Promise.resolve({ summary: "x", chunks: 1, provider: "claude-code" });
    });
    const { onCancel } = renderModal();
    const box = await screen.findByLabelText(/Summary/);
    fireEvent.change(box, { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Compress" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    cleanup();
    expect(signal?.aborted).toBe(true);
  });
});
