import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProviderConfigPicker from "./ProviderConfigPicker";
import { getDefaultOpenRouterEffort, saveDefaultOpenRouterEffort } from "../utils/localStorage";
import type { EffortLevel } from "../utils/localStorage";

const base = {
  provider: "codex" as const,
  onProviderChange: vi.fn(),
  effort: undefined,
  onEffortChange: vi.fn(),
  claudeModel: "",
  onClaudeModelChange: vi.fn(),
  onOpenApiSettings: vi.fn(),
};
const capability = (efforts: string[], extra = {}) => ({ provider: "codex", route: "native", status: "known", efforts, defaultEffort: "medium", ...extra });
const response = (data: unknown) => ({ ok: true, json: async () => data });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("model-aware reasoning picker", () => {
  it("offers catalog max/ultra without claiming catalog recommendation is the runtime default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(capability(["low", "medium", "max", "ultra"]))));
    render(<ProviderConfigPicker {...base} codexModel="gpt-6-astra" />);
    expect(await screen.findByRole("option", { name: "ultra" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "max" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "(default)" })).toBeTruthy();
    expect(screen.queryByText("(default: medium)")).toBeNull();
    expect(screen.queryByRole("option", { name: "none" })).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/codex/reasoning?provider=codex&model=gpt-6-astra", expect.anything());
  });

  it("keeps an unsupported saved value visible and explicitly clearable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(capability(["low", "max"], { route: "openrouter" }))));
    render(<ProviderConfigPicker {...base} effort={"ultra" as EffortLevel} />);
    expect((await screen.findByRole("alert")).textContent).toContain("ultra");
    expect((screen.getByLabelText("Reasoning effort") as HTMLSelectElement).value).toBe("ultra");
    expect((screen.getByLabelText("Reasoning effort") as HTMLSelectElement).checkValidity()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear effort" }));
    expect(base.onEffortChange).toHaveBeenCalledWith(undefined);
  });

  it("does not let stale responses or the previous model's tiers leak into a new model", async () => {
    const pending: Array<(data: unknown) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => pending.push(resolve))),
    );
    const { rerender } = render(<ProviderConfigPicker {...base} codexModel="first" />);
    rerender(<ProviderConfigPicker {...base} codexModel="second" />);
    pending[1](response(capability(["low"])));
    await screen.findByRole("option", { name: "low" });
    pending[0](response(capability(["ultra"])));
    await waitFor(() => expect(screen.queryByRole("option", { name: "ultra" })).toBeNull());
    rerender(<ProviderConfigPicker {...base} codexModel="third" />);
    expect(screen.queryByRole("option", { name: "low" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Loading");
  });

  it("uses no guessed options offline and preserves native legacy summary-none honestly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(capability([], { legacySummaryNone: true }))));
    const { rerender } = render(<ProviderConfigPicker {...base} effort="none" />);
    expect(await screen.findByRole("option", { name: /legacy: hide summaries; default effort/ })).toBeTruthy();
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    rerender(<ProviderConfigPicker {...base} codexModel="unknown" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("unavailable"));
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("re-resolves provider/default changes and never guesses tiers for malformed metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(capability(["max"], { route: "openrouter" })));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<ProviderConfigPicker {...base} codexModel="alias" />);
    await screen.findByRole("option", { name: "max" });
    fetchMock.mockResolvedValue(response({ efforts: [42], status: "known" }));
    rerender(<ProviderConfigPicker {...base} provider="pi" piModel="" />);
    expect(screen.queryByRole("option", { name: "max" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("unavailable"));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/codex/reasoning?provider=pi&model=", expect.anything());
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("offers genuine gateway none, not native ultra, without legacy summary wording", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(capability(["none", "max"], { route: "openrouter" }))));
    render(<ProviderConfigPicker {...base} effort="none" />);
    await screen.findByRole("option", { name: "none" });
    expect(screen.queryByText(/legacy:/)).toBeNull();
    expect(screen.queryByRole("option", { name: "ultra" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Reasoning effort"), { target: { value: "max" } });
    expect(base.onEffortChange).toHaveBeenCalledWith("max");
  });

  it("re-resolves when the execution folder changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(capability(["max"])));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<ProviderConfigPicker {...base} cwd="/native-project" />);
    await screen.findByRole("option", { name: "max" });
    fetchMock.mockResolvedValue(response(capability(["low"], { route: "openrouter" })));
    rerender(<ProviderConfigPicker {...base} cwd="/router-project" />);
    expect(screen.queryByRole("option", { name: "max" })).toBeNull();
    await screen.findByRole("option", { name: "low" });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/codex/reasoning?provider=codex&model=&cwd=%2Frouter-project", expect.anything());
  });

  it("tells its caller when the saved effort must not be submitted, and when it may again", async () => {
    // setCustomValidity alone is inert here: nothing submits a form, so a
    // click-to-create caller has to be told explicitly to hold off.
    const onEffortValidityChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(capability(["low", "max"]))));
    const { rerender } = render(<ProviderConfigPicker {...base} effort={"ultra" as EffortLevel} onEffortValidityChange={onEffortValidityChange} />);
    await screen.findByRole("alert");
    expect(onEffortValidityChange).toHaveBeenLastCalledWith(true);
    rerender(<ProviderConfigPicker {...base} effort="max" onEffortValidityChange={onEffortValidityChange} />);
    await waitFor(() => expect(onEffortValidityChange).toHaveBeenLastCalledWith(false));
    rerender(<ProviderConfigPicker {...base} effort={"ultra" as EffortLevel} provider="claude-code" onEffortValidityChange={onEffortValidityChange} />);
    // No effort control for this harness, so nothing can be blocked by one.
    await waitFor(() => expect(onEffortValidityChange).toHaveBeenLastCalledWith(false));
  });

  it("does not block its caller while the capability is still loading", async () => {
    // Every keystroke in a folder field re-keys the fetch and the Codex probe can
    // take ~1s; an effort that is merely unverified must not hold up creation —
    // the server validates fail-closed on /new/message regardless.
    const onEffortValidityChange = vi.fn();
    let resolveFetch!: (data: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => (resolveFetch = resolve))));
    render(<ProviderConfigPicker {...base} effort="high" cwd="/typing" onEffortValidityChange={onEffortValidityChange} />);
    expect(screen.getByRole("option", { name: /checking/ })).toBeTruthy();
    expect(onEffortValidityChange).toHaveBeenCalledWith(false);
    expect(onEffortValidityChange).not.toHaveBeenCalledWith(true);
    resolveFetch(response(capability(["low"])));
    await waitFor(() => expect(onEffortValidityChange).toHaveBeenLastCalledWith(true));
  });

  it("retains max, ultra and future persisted values for validation rather than downgrading", () => {
    for (const effort of ["max", "ultra", "future"] as EffortLevel[]) {
      saveDefaultOpenRouterEffort(effort);
      expect(getDefaultOpenRouterEffort()).toBe(effort);
    }
    saveDefaultOpenRouterEffort(undefined);
    expect(getDefaultOpenRouterEffort()).toBeUndefined();
  });
});
