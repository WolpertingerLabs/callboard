// @vitest-environment jsdom
/**
 * The picker exists because pi's catalog is ~300 models. These cases are about
 * that number: that the list is filtered rather than dumped, that the cap is
 * *stated* rather than silent, and that a slug the catalog has never heard of
 * still gets through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const getPiModels = vi.fn();
vi.mock("../api", () => ({ getPiModels: (...args: unknown[]) => getPiModels(...args) }));

const PiModelSelector = (await import("./PiModelSelector")).default;

/** A catalog the size of the real one, so the cap is genuinely exercised. */
function bigCatalog(n = 303) {
  return Array.from({ length: n }, (_, i) => ({
    value: `vendor${i % 7}/model-${i}`,
    displayName: `Model ${i}`,
    description: "Supports reasoning",
  }));
}

beforeEach(() => {
  getPiModels.mockReset();
  getPiModels.mockResolvedValue({ providerId: "openrouter", models: bigCatalog() });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSelector(value = "", onChange = vi.fn(), providerId?: string) {
  render(<PiModelSelector value={value} onChange={onChange} providerId={providerId} />);
  return onChange;
}

describe("PiModelSelector", () => {
  it("defaults to the openrouter catalog when no provider is given", async () => {
    renderSelector();
    await waitFor(() => expect(getPiModels).toHaveBeenCalledWith("openrouter"));
  });

  it("fetches the configured provider's catalog instead when one is given", async () => {
    renderSelector("", vi.fn(), "anthropic");
    await waitFor(() => expect(getPiModels).toHaveBeenCalledWith("anthropic"));
  });

  it("treats a blank provider as the default rather than fetching nothing", async () => {
    renderSelector("", vi.fn(), "   ");
    await waitFor(() => expect(getPiModels).toHaveBeenCalledWith("openrouter"));
  });

  /**
   * The whole reason this is not the Cline `<datalist>`: 303 options rendered
   * at once is a scroll, not a picker.
   */
  it("caps the open list well below the catalog size", async () => {
    renderSelector();
    await waitFor(() => expect(getPiModels).toHaveBeenCalled());
    fireEvent.focus(screen.getByRole("textbox"));
    await waitFor(() => expect(screen.getAllByText(/^vendor\d\/model-\d+$/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/^vendor\d\/model-\d+$/).length).toBeLessThanOrEqual(50);
  });

  it("says how many it is hiding, so the cap does not read as 'that is all of them'", async () => {
    renderSelector();
    await waitFor(() => expect(getPiModels).toHaveBeenCalled());
    fireEvent.focus(screen.getByRole("textbox"));
    expect(await screen.findByText(/Showing 50 of 303 — keep typing to narrow/)).toBeTruthy();
  });

  it("drops the hint once the filter fits under the cap", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<PiModelSelector value="" onChange={onChange} />);
    await waitFor(() => expect(getPiModels).toHaveBeenCalled());
    fireEvent.focus(screen.getByRole("textbox"));
    rerender(<PiModelSelector value="model-11" onChange={onChange} />);
    await waitFor(() => expect(screen.queryByText(/keep typing to narrow/)).toBeNull());
  });

  it("filters by subsequence, so separators need not be typed", async () => {
    getPiModels.mockResolvedValue({
      providerId: "openrouter",
      models: [
        { value: "google/gemini-3.6-flash", displayName: "Gemini 3.6 Flash", description: "" },
        { value: "anthropic/claude-opus-4.8", displayName: "Claude Opus", description: "" },
      ],
    });
    render(<PiModelSelector value="g36f" onChange={vi.fn()} />);
    await waitFor(() => expect(getPiModels).toHaveBeenCalled());
    fireEvent.focus(screen.getByRole("textbox"));
    expect(await screen.findByText("google/gemini-3.6-flash")).toBeTruthy();
    expect(screen.queryByText("anthropic/claude-opus-4.8")).toBeNull();
  });

  it("reports the picked model to the caller", async () => {
    getPiModels.mockResolvedValue({
      providerId: "openrouter",
      models: [{ value: "google/gemini-3.6-flash", displayName: "Gemini", description: "" }],
    });
    const onChange = vi.fn();
    render(<PiModelSelector value="" onChange={onChange} />);
    await waitFor(() => expect(getPiModels).toHaveBeenCalled());
    fireEvent.focus(screen.getByRole("textbox"));
    fireEvent.mouseDown(await screen.findByText("google/gemini-3.6-flash"));
    expect(onChange).toHaveBeenCalledWith("google/gemini-3.6-flash");
  });

  it("stays free text when the catalog cannot be read", async () => {
    // A slug newer than the bundled catalog must still be sendable —
    // `findPiModel` falls back to pi's own default rather than failing the turn.
    getPiModels.mockRejectedValue(new Error("offline"));
    const onChange = vi.fn();
    render(<PiModelSelector value="" onChange={onChange} />);
    await waitFor(() => expect(getPiModels).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "vendor/brand-new-model" } });
    expect(onChange).toHaveBeenCalledWith("vendor/brand-new-model");
  });

  it("shows no dropdown when nothing matches, rather than an empty box", async () => {
    render(<PiModelSelector value="zzzzzzzzzz-no-such-model" onChange={vi.fn()} />);
    await waitFor(() => expect(getPiModels).toHaveBeenCalled());
    fireEvent.focus(screen.getByRole("textbox"));
    expect(screen.queryByText(/keep typing to narrow/)).toBeNull();
    expect(screen.queryByText(/^vendor\d\/model-\d+$/)).toBeNull();
  });
});
