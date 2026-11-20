// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import ChatRetentionSection from "./ChatRetentionSection";

const h = vi.hoisted(() => ({
  getEngineRetention: vi.fn(),
  setClaudeRetention: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...h };
});

const claude = (over: Record<string, unknown> = {}) => ({
  engine: "claude-code",
  expires: true,
  configuredDays: null,
  defaultDays: 30,
  effectiveDays: 30,
  settingsPath: "/home/u/.claude/settings.json",
  storagePath: "/home/u/.claude/projects",
  ...over,
});

const all = (c = claude()) => [c, { engine: "codex", expires: false, storagePath: "/home/u/.codex/sessions" }, { engine: "pi", expires: false, storagePath: "/data/pi-sessions" }];

beforeEach(() => {
  h.getEngineRetention.mockReset();
  h.setClaudeRetention.mockReset();
});
afterEach(cleanup);

describe("ChatRetentionSection", () => {
  it("says Codex keeps sessions indefinitely and offers no input", async () => {
    h.getEngineRetention.mockResolvedValue(all());
    render(<ChatRetentionSection engine="codex" />);
    expect(await screen.findByText("Kept indefinitely.")).toBeTruthy();
    expect(screen.getByText("/home/u/.codex/sessions")).toBeTruthy();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("saves a preset for Claude", async () => {
    h.getEngineRetention.mockResolvedValue(all());
    h.setClaudeRetention.mockResolvedValue(claude({ configuredDays: 36500, effectiveDays: 36500 }));
    render(<ChatRetentionSection engine="claude-code" />);
    fireEvent.click(await screen.findByRole("button", { name: "Forever" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(h.setClaudeRetention).toHaveBeenCalledWith(36500));
    expect(await screen.findByText("forever")).toBeTruthy();
  });

  it("warns when lowering the period, and sends null for blank", async () => {
    h.getEngineRetention.mockResolvedValue(all(claude({ configuredDays: 365, effectiveDays: 365 })));
    h.setClaudeRetention.mockResolvedValue(claude());
    render(<ChatRetentionSection engine="claude-code" />);
    const input = await screen.findByRole("spinbutton");
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText(/Shorter than now/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(h.setClaudeRetention).toHaveBeenCalledWith(null));
  });

  it("rejects 0 without calling the API", async () => {
    h.getEngineRetention.mockResolvedValue(all());
    render(<ChatRetentionSection engine="claude-code" />);
    fireEvent.change(await screen.findByRole("spinbutton"), { target: { value: "0" } });
    expect(screen.getByText(/Enter a whole number/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("locks the field under managed policy", async () => {
    h.getEngineRetention.mockResolvedValue(all(claude({ effectiveDays: 14, managedBy: "/etc/claude-code/managed-settings.json" })));
    render(<ChatRetentionSection engine="claude-code" />);
    expect(((await screen.findByRole("spinbutton")) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("/etc/claude-code/managed-settings.json")).toBeTruthy();
  });
});
