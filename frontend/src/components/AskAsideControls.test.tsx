// @vitest-environment jsdom
/**
 * The aside options row: Read only is remembered and pre-selected next time;
 * an explicit harness/model is remembered as a one-click recent choice but the
 * default stays "Same as chat"; the choice reaches `onAsk`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AskAsideControls from "./AskAsideControls";
import { getAsideReadOnly, getAsideRecentTarget, saveAsideRecentTarget } from "../utils/localStorage";

// The model pickers fetch catalogs; a plain input stands in for each.
const fakeSelector = vi.hoisted(() => (name: string) => ({
  default: ({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) => (
    <input id={id} data-testid={name} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock("./ClaudeModelSelector", () => fakeSelector("ClaudeModelSelector"));
vi.mock("./CodexModelSelector", () => fakeSelector("CodexModelSelector"));
vi.mock("./PiModelSelector", () => fakeSelector("PiModelSelector"));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const renderControls = (onAsk = vi.fn(async () => true)) => {
  render(<AskAsideControls chatProvider="claude-code" busy={false} onAsk={onAsk} />);
  return onAsk;
};
const readOnly = () => screen.getByRole("button", { name: "Read only" });
const harness = () => screen.getByLabelText("Aside harness") as HTMLSelectElement;
const ask = () => fireEvent.click(screen.getByRole("button", { name: "Ask as aside" }));

describe("AskAsideControls", () => {
  it("remembers Read only and pre-selects it next time", async () => {
    const onAsk = renderControls();
    expect(readOnly().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(readOnly());
    expect(getAsideReadOnly()).toBe(true);
    ask();
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith({ readOnly: true, target: null }));

    cleanup();
    renderControls();
    expect(readOnly().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(readOnly());
    expect(getAsideReadOnly()).toBe(false);
  });

  it("defaults to Same as chat, and remembers an explicit choice once the aside is created", async () => {
    const onAsk = renderControls();
    expect(harness().value).toBe("");
    expect(harness().selectedOptions[0]!.textContent).toBe("Same as chat (Claude Code)");
    fireEvent.change(harness(), { target: { value: "codex" } });
    fireEvent.change(screen.getByTestId("CodexModelSelector"), { target: { value: " gpt-x " } });
    ask();
    await waitFor(() => expect(onAsk).toHaveBeenCalledWith({ readOnly: false, target: { provider: "codex", model: "gpt-x" } }));
    await waitFor(() => expect(getAsideRecentTarget()).toEqual({ provider: "codex", model: "gpt-x" }));

    // Next time: still Same as chat, with the recent choice one click away.
    cleanup();
    const next = renderControls();
    expect(harness().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Codex · gpt-x" }));
    expect(harness().value).toBe("codex");
    ask();
    await waitFor(() => expect(next).toHaveBeenCalledWith({ readOnly: false, target: { provider: "codex", model: "gpt-x" } }));
  });

  it("does not remember a choice whose aside was not created", async () => {
    saveAsideRecentTarget({ provider: "pi" });
    renderControls(vi.fn(async () => false));
    fireEvent.change(harness(), { target: { value: "codex" } });
    ask();
    await waitFor(() => expect(getAsideRecentTarget()).toEqual({ provider: "pi" }));
  });

  it("ignores a malformed stored target", () => {
    localStorage.setItem("claude-code-settings", JSON.stringify({ asideRecentTarget: { provider: "cline", model: 3 } }));
    expect(getAsideRecentTarget()).toBeNull();
    renderControls();
    expect(screen.queryByTitle(/last aside/)).toBeNull();
  });

  it("disables the button while busy and shows the error", () => {
    render(<AskAsideControls chatProvider="codex" busy error="nope" onAsk={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Asking…" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("alert").textContent).toBe("nope");
  });
});
