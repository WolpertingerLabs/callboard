/**
 * The New Chat popup must not create a chat whose stored reasoning effort the
 * picker has already flagged as unsupported.
 *
 * The stored effort is restored verbatim on open (so a stale level can be
 * explained rather than silently downgraded), and the picker marks the select
 * invalid with `setCustomValidity`. But no form is submitted here — creation is
 * a click on a directory — so that validity was never consulted, and the chat
 * was created only to fail on its first message with the server's 400.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import NewChatPanel from "./NewChatPanel";
import { resetSystemInfoCache } from "../api";
import { addRecentDirectory, saveDefaultOpenRouterEffort, saveDefaultProvider, type EffortLevel } from "../utils/localStorage";

/** Serve the capability for the folder the picker evaluated; `efforts === null` never answers. */
function serve(efforts: string[] | null) {
  return vi.fn((url: string) => {
    const path = String(url);
    if (path.includes("/system-info")) return Promise.resolve({ ok: true, json: async () => ({ version: "1.0.0", acpProviders: [], codexConfigured: true }) });
    if (path.includes("/codex/reasoning")) {
      if (efforts === null) return new Promise(() => {});
      return Promise.resolve({ ok: true, json: async () => ({ provider: "codex", route: "codex", status: "known", efforts, message: "" }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

const app = () => (
  <MemoryRouter>
    <Routes>
      <Route path="/" element={<NewChatPanel onClose={() => {}} />} />
      <Route path="/chat/new" element={<div>navigated to new chat</div>} />
    </Routes>
  </MemoryRouter>
);

beforeEach(() => {
  resetSystemInfoCache();
  localStorage.clear();
  saveDefaultProvider("codex");
  saveDefaultOpenRouterEffort("ultra" as EffortLevel);
  addRecentDirectory("/tmp/recent-project");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("New Chat with a stored effort the model does not support", () => {
  it("refuses to create the chat and surfaces the picker's validity message", async () => {
    vi.stubGlobal("fetch", serve(["low", "medium"]));
    render(app());
    await screen.findByRole("alert");
    const select = screen.getByLabelText("Reasoning effort") as HTMLSelectElement;
    const reportValidity = vi.spyOn(select, "reportValidity");
    fireEvent.click(screen.getByTitle("/tmp/recent-project"));
    expect(screen.queryByText("navigated to new chat")).toBeNull();
    expect(reportValidity).toHaveBeenCalled();
    expect(select.checkValidity()).toBe(false);
  });

  it("creates the chat once the effort is supported", async () => {
    vi.stubGlobal("fetch", serve(["low", "ultra"]));
    render(app());
    await screen.findByRole("option", { name: "ultra" });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.click(screen.getByTitle("/tmp/recent-project"));
    expect(await screen.findByText("navigated to new chat")).toBeTruthy();
  });

  it("creates the chat while the capability is still loading — unverified is not unsupported", async () => {
    // The Codex probe takes up to ~1s per cwd and re-runs on every keystroke;
    // a recent-directory click in that window must go through to the server,
    // which validates fail-closed itself.
    vi.stubGlobal("fetch", serve(null));
    render(app());
    await screen.findByRole("option", { name: /checking/ });
    fireEvent.click(screen.getByTitle("/tmp/recent-project"));
    expect(await screen.findByText("navigated to new chat")).toBeTruthy();
  });

  it("leaves a directory the picker did not evaluate to the server", async () => {
    // The picker resolves capabilities for `displayPath` (the most recent
    // directory). Another directory may carry its own project config, so a
    // stale verdict for one must not refuse a click on the other.
    addRecentDirectory("/tmp/other-project"); // becomes displayPath
    vi.stubGlobal("fetch", serve(["low", "medium"]));
    render(app());
    await screen.findByRole("alert");
    fireEvent.click(screen.getByTitle("/tmp/recent-project"));
    expect(await screen.findByText("navigated to new chat")).toBeTruthy();
  });

  it("creates the chat once the unsupported effort is cleared", async () => {
    vi.stubGlobal("fetch", serve(["low", "medium"]));
    render(app());
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Clear effort" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.click(screen.getByTitle("/tmp/recent-project"));
    expect(await screen.findByText("navigated to new chat")).toBeTruthy();
  });
});
