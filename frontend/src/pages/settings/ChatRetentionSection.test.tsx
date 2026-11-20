// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import ChatRetentionSection, { parseDays } from "./ChatRetentionSection";

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

const all = (c: unknown = claude()) => [c, { engine: "codex", expires: false, storagePath: "/home/u/.codex/sessions" }, { engine: "pi", expires: false, storagePath: "/data/pi-sessions" }];

const box = () => screen.findByLabelText("Days to keep Claude chats") as Promise<HTMLInputElement>;
const saveButton = () => screen.getByRole("button", { name: /^(Save|Saving\.\.\.|Saved!)$/ }) as HTMLButtonElement;

beforeEach(() => {
  h.getEngineRetention.mockReset();
  h.setClaudeRetention.mockReset();
});
afterEach(cleanup);

describe("parseDays", () => {
  it.each([
    ["", { valid: true, days: null }],
    ["  ", { valid: true, days: null }],
    [" 90 ", { valid: true, days: 90 }],
    ["36500", { valid: true, days: 36500 }],
  ])("accepts %j", (input, out) => expect(parseDays(input)).toEqual(out));

  it.each(["0", "-5", "1e3", "0x10", "90.0", "14d", "36501", "abc"])("rejects %j", (input) => expect(parseDays(input)).toEqual({ valid: false }));
});

describe("ChatRetentionSection", () => {
  it("says Codex keeps sessions indefinitely and offers no input", async () => {
    h.getEngineRetention.mockResolvedValue(all());
    render(<ChatRetentionSection engine="codex" />);
    expect(await screen.findByText("Kept indefinitely.")).toBeTruthy();
    expect(screen.getByText("/home/u/.codex/sessions")).toBeTruthy();
    expect(screen.queryByLabelText("Days to keep Claude chats")).toBeNull();
  });

  it("says so when the server does not report the engine, instead of loading forever", async () => {
    h.getEngineRetention.mockResolvedValue([]);
    render(<ChatRetentionSection engine="pi" />);
    expect(await screen.findByText(/doesn.t report chat retention for pi/)).toBeTruthy();
  });

  it("shows a load error", async () => {
    h.getEngineRetention.mockRejectedValue(new Error("daemon down"));
    render(<ChatRetentionSection engine="claude-code" />);
    expect(await screen.findByText("daemon down")).toBeTruthy();
  });

  it("saves the Forever preset and then describes it as keeping chats indefinitely", async () => {
    h.getEngineRetention.mockResolvedValue(all());
    h.setClaudeRetention.mockResolvedValue(claude({ configuredDays: 36500, effectiveDays: 36500 }));
    render(<ChatRetentionSection engine="claude-code" />);
    fireEvent.click(await screen.findByRole("button", { name: "Forever" }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(h.setClaudeRetention).toHaveBeenCalledWith(36500));
    expect(await screen.findByText("keep chats indefinitely")).toBeTruthy();
    expect(screen.queryByText(/forever\b/)).toBeNull();
    expect((await box()).value).toBe("36500");
  });

  it("saves on Enter", async () => {
    h.getEngineRetention.mockResolvedValue(all());
    h.setClaudeRetention.mockResolvedValue(claude({ configuredDays: 90, effectiveDays: 90 }));
    render(<ChatRetentionSection engine="claude-code" />);
    const input = await box();
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(h.setClaudeRetention).toHaveBeenCalledWith(90));
  });

  it("re-syncs the box from the server's answer, not from what was typed", async () => {
    h.getEngineRetention.mockResolvedValue(all());
    h.setClaudeRetention.mockResolvedValue(claude({ configuredDays: 120, effectiveDays: 120 }));
    render(<ChatRetentionSection engine="claude-code" />);
    const input = await box();
    fireEvent.change(input, { target: { value: " 90 " } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(input.value).toBe("120"));
  });

  it("warns when lowering to a smaller number", async () => {
    h.getEngineRetention.mockResolvedValue(all(claude({ configuredDays: 365, effectiveDays: 365 })));
    render(<ChatRetentionSection engine="claude-code" />);
    fireEvent.change(await box(), { target: { value: "90" } });
    expect(screen.getByText(/Shorter than now: .* last 90 days/)).toBeTruthy();
  });

  it("warns when clearing back to a shorter default, and sends null", async () => {
    h.getEngineRetention.mockResolvedValue(all(claude({ configuredDays: 365, effectiveDays: 365 })));
    h.setClaudeRetention.mockResolvedValue(claude());
    render(<ChatRetentionSection engine="claude-code" />);
    fireEvent.change(await box(), { target: { value: "" } });
    expect(screen.getByText(/Shorter than now/)).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => expect(h.setClaudeRetention).toHaveBeenCalledWith(null));
  });

  it("does not warn when raising the value or leaving it unchanged", async () => {
    h.getEngineRetention.mockResolvedValue(all(claude({ configuredDays: 90, effectiveDays: 90 })));
    render(<ChatRetentionSection engine="claude-code" />);
    const input = await box();
    expect(screen.queryByText(/Shorter than now/)).toBeNull();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: "365" } });
    expect(screen.queryByText(/Shorter than now/)).toBeNull();
  });

  it.each(["0", "abc", "14d", "1e3"])("rejects %j without offering to save it as the default", async (value) => {
    h.getEngineRetention.mockResolvedValue(all(claude({ configuredDays: 14, effectiveDays: 14 })));
    render(<ChatRetentionSection engine="claude-code" />);
    const input = await box();
    fireEvent.change(input, { target: { value } });
    expect(screen.getByText(/Enter a whole number/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.setClaudeRetention).not.toHaveBeenCalled();
  });

  it("shows no error on load for an out-of-range value written by hand, and no warning for Forever", async () => {
    h.getEngineRetention.mockResolvedValue(all(claude({ configuredDays: 99999, effectiveDays: 99999 })));
    render(<ChatRetentionSection engine="claude-code" />);
    expect((await box()).value).toBe("99999");
    expect(screen.queryByText(/Enter a whole number/)).toBeNull();
    expect(screen.getByText("keep chats indefinitely")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forever" }));
    expect(screen.queryByText(/Shorter than now/)).toBeNull();
  });

  it("shows a save error and re-reads the state, so a now-unparseable file locks the field", async () => {
    h.getEngineRetention
      .mockResolvedValueOnce(all())
      .mockResolvedValueOnce(all(claude({ unreadable: "Unexpected token" })));
    h.setClaudeRetention.mockRejectedValue(new Error("could not be parsed"));
    render(<ChatRetentionSection engine="claude-code" />);
    fireEvent.change(await box(), { target: { value: "90" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText("could not be parsed")).toBeTruthy();
    await waitFor(() => expect(h.getEngineRetention).toHaveBeenCalledTimes(2));
    await waitFor(async () => expect((await box()).disabled).toBe(true));
    expect(screen.getByText(/isn.t valid JSON \(Unexpected token\)/)).toBeTruthy();
  });

  it("disables Save for a shortening this client may not make, and says why before Save", async () => {
    h.getEngineRetention.mockResolvedValue(all(claude({ configuredDays: 365, effectiveDays: 365, canShorten: false })));
    render(<ChatRetentionSection engine="claude-code" />);
    const input = await box();
    fireEvent.change(input, { target: { value: "90" } });
    expect(screen.getByText(/through a proxy \(Tailscale included\), which is how this page is connected/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    // Lengthening is still allowed from the same client.
    fireEvent.change(input, { target: { value: "400" } });
    expect(saveButton().disabled).toBe(false);
  });

  it("explains an invalid value in the file, quietly until the user acts, and treats saving anything as turning cleanup on", async () => {
    h.getEngineRetention.mockResolvedValue(all(claude({ invalidValue: "0", canShorten: false })));
    render(<ChatRetentionSection engine="claude-code" />);
    expect(await screen.findByText(/skips cleanup and deletes nothing/)).toBeTruthy();
    expect(screen.queryByText(/Claude's default/)).toBeNull();
    // On load: nothing looks like an unsaved edit, and Default is not claimed.
    expect(screen.queryByText(/Shorter than now/)).toBeNull();
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Default" }).style.background).toBe("var(--surface)");
    // Picking Default is a real change, and a reduction from "nothing is deleted".
    fireEvent.click(screen.getByRole("button", { name: "Default" }));
    expect(screen.getByText(/Shorter than now/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Forever" }));
    expect(screen.queryByText(/Shorter than now/)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("keeps the shrink gate after a successful save", async () => {
    h.getEngineRetention.mockResolvedValue(all(claude({ configuredDays: 365, effectiveDays: 365, canShorten: false })));
    // What the daemon answers: the PUT carries canShorten too.
    h.setClaudeRetention.mockResolvedValue(claude({ configuredDays: 36500, effectiveDays: 36500, canShorten: false }));
    render(<ChatRetentionSection engine="claude-code" />);
    fireEvent.click(await screen.findByRole("button", { name: "Forever" }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(h.setClaudeRetention).toHaveBeenCalledWith(36500));
    await screen.findByText("keep chats indefinitely");
    fireEvent.click(screen.getByRole("button", { name: "90 days" }));
    expect(screen.getByText(/which is how this page is connected/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it("clears a save error once the user edits again, and does not show Saved! beside a later failure", async () => {
    h.getEngineRetention.mockResolvedValue(all());
    h.setClaudeRetention.mockResolvedValueOnce(claude({ configuredDays: 90, effectiveDays: 90 })).mockRejectedValueOnce(new Error("refused"));
    render(<ChatRetentionSection engine="claude-code" />);
    const input = await box();
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.click(saveButton());
    expect(await screen.findByRole("button", { name: "Saved!" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText("refused")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Saved!" })).toBeNull();
    fireEvent.change(input, { target: { value: "121" } });
    expect(screen.queryByText("refused")).toBeNull();
  });

  it("keeps the box focusable (readOnly, not disabled) while saving", async () => {
    h.getEngineRetention.mockResolvedValue(all());
    let resolve: (v: unknown) => void = () => undefined;
    h.setClaudeRetention.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<ChatRetentionSection engine="claude-code" />);
    const input = await box();
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.readOnly).toBe(true));
    expect(input.disabled).toBe(false);
    resolve(claude({ configuredDays: 90, effectiveDays: 90 }));
    await waitFor(() => expect(input.readOnly).toBe(false));
  });

  it("locks the field under managed policy", async () => {
    h.getEngineRetention.mockResolvedValue(all(claude({ effectiveDays: 14, managedBy: "/etc/claude-code/managed-settings.json" })));
    render(<ChatRetentionSection engine="claude-code" />);
    expect((await box()).disabled).toBe(true);
    expect(screen.getByText("/etc/claude-code/managed-settings.json")).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it("locks the field when the settings file is unreadable", async () => {
    h.getEngineRetention.mockResolvedValue(all(claude({ unreadable: "Unexpected end of JSON input" })));
    render(<ChatRetentionSection engine="claude-code" />);
    expect((await box()).disabled).toBe(true);
    expect(screen.getByText(/Unexpected end of JSON input/)).toBeTruthy();
  });
});
