// @vitest-environment jsdom
/**
 * The aside options row: Read only is remembered and pre-selected next time;
 * an explicit harness/model is remembered as a one-click recent choice but the
 * default stays "Same as chat"; the choice reaches `onAsk`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AskAsideControls, { readOnlyTooltip, type AskAsideResult } from "./AskAsideControls";
import { getAsideReadOnly, getAsideRecentTarget, saveAsideRecentTarget } from "../utils/localStorage";
import { getAgentSettings } from "../api";

// The model pickers fetch catalogs; a plain input stands in for each.
const fakeSelector = vi.hoisted(() => (name: string) => ({
  default: ({ id, value, onChange, providerId }: { id?: string; value: string; onChange: (v: string) => void; providerId?: string }) => (
    <input id={id} data-testid={name} data-provider-id={providerId ?? ""} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock("../api", () => ({ getAgentSettings: vi.fn(async () => ({ piProviderId: "anthropic" })) }));
vi.mock("./ClaudeModelSelector", () => fakeSelector("ClaudeModelSelector"));
vi.mock("./CodexModelSelector", () => fakeSelector("CodexModelSelector"));
vi.mock("./PiModelSelector", () => fakeSelector("PiModelSelector"));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const renderControls = (onAsk = vi.fn(async (): Promise<AskAsideResult> => "started")) => {
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

  it("remembers a choice only once its aside has started", async () => {
    saveAsideRecentTarget({ provider: "pi" });
    const onAsk = renderControls(vi.fn(async (): Promise<AskAsideResult> => "created"));
    fireEvent.change(harness(), { target: { value: "codex" } });
    ask();
    await waitFor(() => expect(onAsk).toHaveBeenCalled());
    expect(getAsideRecentTarget()).toEqual({ provider: "pi" });
  });

  it("forgets the stored choice when the daemon refuses it, and only that one", async () => {
    saveAsideRecentTarget({ provider: "codex", model: "gone" });
    const onAsk = renderControls(vi.fn(async (): Promise<AskAsideResult> => "refused"));
    fireEvent.click(screen.getByRole("button", { name: "Codex · gone" }));
    ask();
    await waitFor(() => expect(onAsk).toHaveBeenCalled());
    await waitFor(() => expect(getAsideRecentTarget()).toBeNull());
    expect(screen.queryByRole("button", { name: "Codex · gone" })).toBeNull();

    // A refusal on another choice leaves the stored one alone.
    cleanup();
    saveAsideRecentTarget({ provider: "pi" });
    renderControls(vi.fn(async (): Promise<AskAsideResult> => "refused"));
    fireEvent.change(harness(), { target: { value: "codex" } });
    ask();
    await waitFor(() => expect(getAsideRecentTarget()).toEqual({ provider: "pi" }));
  });

  it("keeps the stored choice when the request failed for another reason", async () => {
    saveAsideRecentTarget({ provider: "codex" });
    const onAsk = renderControls(vi.fn(async (): Promise<AskAsideResult> => "failed"));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    ask();
    await waitFor(() => expect(onAsk).toHaveBeenCalled());
    expect(getAsideRecentTarget()).toEqual({ provider: "codex" });
  });

  it("says what Read only guarantees on the harness the aside will run on", () => {
    renderControls();
    expect(readOnly().title).toBe(readOnlyTooltip("claude-code"));
    expect(readOnly().title).toMatch(/asks you before writing files or running code/);
    fireEvent.change(harness(), { target: { value: "codex" } });
    expect(readOnly().title).toMatch(/read-only sandbox.*commands inside it run without asking/);
    cleanup();
    render(<AskAsideControls chatProvider="codex" busy={false} onAsk={vi.fn()} />);
    expect(readOnly().title).toBe(readOnlyTooltip("codex"));
  });

  it("is disabled with the reason while blocked", () => {
    const onAsk = vi.fn();
    render(<AskAsideControls chatProvider="claude-code" busy={false} blockedReason="no commands" onAsk={onAsk} />);
    expect(screen.getByRole("button", { name: "Ask as aside" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("status").textContent).toBe("no commands");
    ask();
    expect(onAsk).not.toHaveBeenCalled();
  });

  it("offers pi models from the configured pi provider", async () => {
    renderControls();
    fireEvent.change(harness(), { target: { value: "pi" } });
    await waitFor(() => expect(screen.getByTestId("PiModelSelector").getAttribute("data-provider-id")).toBe("anthropic"));
    expect(getAgentSettings).toHaveBeenCalledTimes(1);
  });

  it("uses 44px touch targets on a narrow screen", () => {
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
    try {
      renderControls();
      for (const name of ["Read only", "Ask as aside"]) expect(screen.getByRole("button", { name }).style.minHeight).toBe("44px");
      expect(harness().style.minHeight).toBe("44px");
    } finally {
      Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    }
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
