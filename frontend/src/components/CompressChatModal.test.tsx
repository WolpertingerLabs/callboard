// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => {
  class StaleSummaryError extends Error {}
  return { previewChatCompression: vi.fn(), compressChat: vi.fn(), StaleSummaryError };
});
vi.mock("../api", () => api);

const { default: CompressChatModal, SLOW_PREVIEW_MS } = await import("./CompressChatModal");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const TS = "2026-01-01T00:00:00.000Z";
const PRECONDITION = { expectedParentChatId: "parent-1" };
const preview = (summary: string, fingerprint = "fp-1") => ({ summary, chunks: 1, fingerprint, provider: "claude-code" });
const renderModal = (onDone = vi.fn(), onCancel = vi.fn()) => {
  render(<CompressChatModal chatId="c1" timestamp={TS} direction="before" precondition={PRECONDITION} onCancel={onCancel} onDone={onDone} />);
  return { onDone, onCancel };
};

describe("CompressChatModal", () => {
  it("fetches the summary, lets the user edit it, and commits the edited text with the preview's fingerprint", async () => {
    api.previewChatCompression.mockResolvedValue(preview("model summary"));
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
    expect(api.compressChat).toHaveBeenCalledWith("c1", TS, "before", "my edited summary", "fp-1", PRECONDITION);
  });

  it("shows a failed preview and retries it", async () => {
    api.previewChatCompression.mockRejectedValueOnce(new Error("model unavailable")).mockResolvedValueOnce(preview("second try"));
    renderModal();
    expect((await screen.findByRole("alert")).textContent).toContain("model unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(((await screen.findByDisplayValue("second try")) as HTMLTextAreaElement).value).toBe("second try");
    expect(api.previewChatCompression).toHaveBeenCalledTimes(2);
  });

  it("asks for a fresh summary when the chat changed since the preview, then commits with the new fingerprint", async () => {
    api.previewChatCompression.mockResolvedValueOnce(preview("old", "fp-old")).mockResolvedValueOnce(preview("new", "fp-new"));
    api.compressChat
      .mockRejectedValueOnce(new api.StaleSummaryError("The conversation changed since the summary was generated."))
      .mockResolvedValueOnce({ chat: { id: "n" }, original: null });
    const { onDone } = renderModal();
    await screen.findByDisplayValue("old");
    fireEvent.click(screen.getByRole("button", { name: "Compress" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed since the summary/);
    // A stale summary cannot be committed — only regenerated.
    expect(screen.queryByRole("button", { name: "Compress" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate summary" }));
    await screen.findByDisplayValue("new");
    fireEvent.click(screen.getByRole("button", { name: "Compress" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.compressChat).toHaveBeenLastCalledWith("c1", TS, "before", "new", "fp-new", PRECONDITION);
  });

  it("cannot be dismissed while the commit is in flight", async () => {
    api.previewChatCompression.mockResolvedValue(preview("s"));
    let finish!: (v: unknown) => void;
    api.compressChat.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { onCancel, onDone } = renderModal();
    await screen.findByDisplayValue("s");
    fireEvent.click(screen.getByRole("button", { name: "Compress" }));
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => finish({ chat: { id: "n" }, original: null }));
    expect(onDone).toHaveBeenCalled();
  });

  it("explains a slow preview on a long chat", async () => {
    vi.useFakeTimers();
    api.previewChatCompression.mockReturnValue(new Promise(() => {}));
    renderModal();
    expect(screen.getByRole("status").textContent).not.toMatch(/summarised in parts/);
    act(() => {
      vi.advanceTimersByTime(SLOW_PREVIEW_MS);
    });
    expect(screen.getByRole("status").textContent).toMatch(/summarised in parts.*proxy/);
  });

  it("will not commit an empty summary, and cancels the preview when closed", async () => {
    let signal: AbortSignal | undefined;
    api.previewChatCompression.mockImplementation((_id, _ts, _dir, s: AbortSignal) => {
      signal = s;
      return Promise.resolve(preview("x"));
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
