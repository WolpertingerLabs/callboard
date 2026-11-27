// @vitest-environment jsdom
/**
 * The offline fallback mirrors the backend's `STATIC_MODELS` in
 * `codex-models.ts`: slugs the bundled codex-cli 0.172 catalog actually serves.
 * A stale slug here is worse than none — picking it fails with model_not_found.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const getCodexModels = vi.fn();
vi.mock("../api", () => ({ getCodexModels: (...args: unknown[]) => getCodexModels(...args) }));

const CodexModelSelector = (await import("./CodexModelSelector")).default;

beforeEach(() => {
  getCodexModels.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CodexModelSelector", () => {
  it("offers current slugs when the live catalog is unavailable", async () => {
    getCodexModels.mockRejectedValue(new Error("offline"));
    render(<CodexModelSelector value="" onChange={vi.fn()} />);
    await waitFor(() => expect(getCodexModels).toHaveBeenCalled());
    fireEvent.focus(screen.getByRole("textbox"));
    expect(await screen.findByText("gpt-6.2-sol")).toBeTruthy();
    expect(screen.queryByText("gpt-5.5")).toBeNull();
  });

  it("replaces the fallback with the live catalog", async () => {
    getCodexModels.mockResolvedValue([{ id: "live-model", name: "Live", visibility: "list" }]);
    render(<CodexModelSelector value="" onChange={vi.fn()} />);
    fireEvent.focus(screen.getByRole("textbox"));
    expect(await screen.findByText("live-model")).toBeTruthy();
    expect(screen.queryByText("gpt-6.2-sol")).toBeNull();
  });
});
