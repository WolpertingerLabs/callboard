import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxDesktopStatus } from "shared/types/index.js";
import SandboxDesktopSettings from "./SandboxDesktopSettings";
import { buildSandboxDesktopImage, getSandboxDesktopStatus, updateSandboxDesktopSettings } from "../../api";

vi.mock("../../api", () => ({ getSandboxDesktopStatus: vi.fn(), updateSandboxDesktopSettings: vi.fn(), buildSandboxDesktopImage: vi.fn() }));

function status(overrides: Partial<SandboxDesktopStatus> = {}): SandboxDesktopStatus {
  return {
    settings: {},
    effectiveMode: "managed",
    automatic: true,
    diagnostics: {
      docker: { reachable: true, version: "29.1.3" },
      image: {
        name: "callboard/computer-use-desktop:local",
        present: true,
        protocol: "2.0",
        version: "0.1.0",
        compatible: true,
        expectedProtocol: "2.0",
        packageVersion: "0.1.0",
      },
      network: { name: "callboard-sandbox", internal: false, state: "ok" },
      running: { sessions: 1, limit: 2, containers: 1 },
      endpoint: { configured: false },
    },
    build: { state: "idle" },
    buildCommand: "callboard sandbox build",
    canEdit: true,
    owner: "0123456789abcdef",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getSandboxDesktopStatus).mockReset();
  vi.mocked(updateSandboxDesktopSettings).mockReset();
  vi.mocked(buildSandboxDesktopImage).mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Settings → Sandbox desktop", () => {
  it("shows the mode in force, diagnostics and the owner", async () => {
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status());
    render(<SandboxDesktopSettings />);
    expect((await screen.findByTestId("sandbox-effective-mode")).textContent).toContain("Managed (local Docker) (automatic)");
    expect(screen.getByTestId("sandbox-diagnostic-docker").textContent).toContain("reachable (server 29.1.3)");
    expect(screen.getByTestId("sandbox-diagnostic-image").textContent).toContain("protocol 2.0 (compatible)");
    expect(screen.getByTestId("sandbox-diagnostic-running").textContent).toContain("1 of 2 managed sandboxes");
    expect(screen.getByText("0123456789abcdef")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rebuild image" })).toBeTruthy();
  });

  it("edits the kept-for-recovery retention and cap", async () => {
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status());
    vi.mocked(updateSandboxDesktopSettings).mockResolvedValue(status({ settings: { keepHours: 72, maxKept: 0 } }));
    render(<SandboxDesktopSettings />);
    const hours = (await screen.findByLabelText("Keep for recovery (hours)")) as HTMLInputElement;
    expect(hours.value).toBe("24");
    expect(hours.min).toBe("1");
    expect(hours.max).toBe("168");
    fireEvent.change(hours, { target: { value: "72" } });
    expect(screen.getByText(/kept this long, then removed/)).toBeTruthy();
    expect(screen.getByText(/across all chats; each holds its memory while paused/)).toBeTruthy();
    expect((screen.getByLabelText("Deliverables storage (GiB)") as HTMLInputElement).value).toBe("5");
    fireEvent.change(screen.getByLabelText("Kept at once"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(updateSandboxDesktopSettings).toHaveBeenCalledWith(expect.objectContaining({ keepHours: 72, maxKept: 0 })));
  });

  it("saves a change, sending automatic as null", async () => {
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ settings: { mode: "off" }, automatic: false, effectiveMode: "off" }));
    vi.mocked(updateSandboxDesktopSettings).mockResolvedValue(status({ settings: { network: "none", maxConcurrent: 3 } }));
    // One session is running (the fixture's default), so the mode change asks first.
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SandboxDesktopSettings />);
    fireEvent.change(await screen.findByLabelText("Mode"), { target: { value: "auto" } });
    fireEvent.change(screen.getByLabelText("Network (managed)"), { target: { value: "none" } });
    fireEvent.change(screen.getByLabelText("Sandboxes at once"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateSandboxDesktopSettings).toHaveBeenCalledWith({
        mode: null,
        network: "none",
        cpus: 1,
        memoryMb: 1024,
        maxConcurrent: 3,
        keepHours: 24,
        maxKept: 2,
        deliverablesGb: 5,
      }),
    );
  });

  it("is read only for an API key: no save, no build", async () => {
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ canEdit: false }));
    render(<SandboxDesktopSettings />);
    expect(await screen.findByText(/Read only/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Rebuild image" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Mode") as HTMLSelectElement).disabled).toBe(true);
  });

  it("points at the build when the image is missing, and builds on request", async () => {
    const missing = status({
      effectiveMode: "off",
      problem: "image-missing",
      hint: "Build the image once with `callboard sandbox build`, or with Build image below.",
    });
    missing.diagnostics.image = { ...missing.diagnostics.image, present: false, compatible: false, protocol: undefined, version: undefined };
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(missing);
    vi.mocked(buildSandboxDesktopImage).mockResolvedValue({ state: "running", startedAt: 1, output: "Step 1/20" });
    render(<SandboxDesktopSettings />);
    expect((await screen.findByTestId("sandbox-effective-mode")).textContent).toContain("callboard sandbox build");
    expect(screen.getByTestId("sandbox-diagnostic-image").textContent).toContain("is not built");
    fireEvent.click(screen.getByRole("button", { name: "Build image" }));
    expect(await screen.findByText("Step 1/20")).toBeTruthy();
    expect(buildSandboxDesktopImage).toHaveBeenCalledTimes(1);
  });

  it("says limits and network apply to sandboxes started after saving", async () => {
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status());
    render(<SandboxDesktopSettings />);
    await screen.findByLabelText("Mode");
    expect(screen.getByText(/^Applies to sandboxes started after saving/)).toBeTruthy();
    expect(screen.getByText(/^Limits apply to sandboxes started after saving/)).toBeTruthy();
  });

  it("asks before a mode change that ends running sessions, and saves nothing if declined", async () => {
    const running = status({ settings: {}, automatic: true });
    running.diagnostics.running.sessions = 2;
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(running);
    vi.mocked(updateSandboxDesktopSettings).mockResolvedValue(status({ settings: { mode: "off" } }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    try {
      render(<SandboxDesktopSettings />);
      fireEvent.change(await screen.findByLabelText("Mode"), { target: { value: "off" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(confirm).toHaveBeenLastCalledWith("Changing the mode ends 2 running sandbox sessions. Continue?");
      expect(updateSandboxDesktopSettings).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(updateSandboxDesktopSettings).toHaveBeenCalledWith(expect.objectContaining({ mode: "off" })));
    } finally {
      confirm.mockRestore();
    }
  });

  it("does not ask when the mode is unchanged or nothing is running", async () => {
    const running = status({ settings: {}, automatic: true });
    running.diagnostics.running.sessions = 1;
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(running);
    vi.mocked(updateSandboxDesktopSettings).mockResolvedValue(status());
    const confirm = vi.spyOn(window, "confirm");
    try {
      render(<SandboxDesktopSettings />);
      fireEvent.change(await screen.findByLabelText("Sandboxes at once"), { target: { value: "3" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(updateSandboxDesktopSettings).toHaveBeenCalled());
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it("reports an out-of-date image as a warning with a rebuild action", async () => {
    const outdated = status({ warning: "image-outdated", warningHint: "The image was not built from the files this Callboard ships." });
    outdated.diagnostics.image = { ...outdated.diagnostics.image, current: false, content: "old", expectedContent: "new" };
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(outdated);
    render(<SandboxDesktopSettings />);
    expect((await screen.findByTestId("sandbox-effective-mode")).textContent).toContain("Image out of date");
    expect(screen.getByTestId("sandbox-diagnostic-image").textContent).toContain("out of date");
    expect(screen.getByTestId("sandbox-diagnostic-image").textContent).toContain("Sandboxes still start");
    expect(screen.getByRole("button", { name: "Rebuild image (out of date)" })).toBeTruthy();
  });

  it("does not warn when Automatic already means managed and Managed is chosen (the mode in force is unchanged)", async () => {
    const running = status({ settings: {}, automatic: true, effectiveMode: "managed" });
    running.diagnostics.running.sessions = 2;
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(running);
    vi.mocked(updateSandboxDesktopSettings).mockResolvedValue(status({ settings: { mode: "managed" }, automatic: false }));
    const confirm = vi.spyOn(window, "confirm");
    render(<SandboxDesktopSettings />);
    fireEvent.change(await screen.findByLabelText("Mode"), { target: { value: "managed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSandboxDesktopSettings).toHaveBeenCalledWith(expect.objectContaining({ mode: "managed" })));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does warn when Automatic means endpoint and Managed is chosen", async () => {
    const running = status({ settings: {}, automatic: true, effectiveMode: "endpoint" });
    running.diagnostics.running.sessions = 1;
    running.diagnostics.endpoint = { configured: true, url: "http://127.0.0.1:7801" };
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(running);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SandboxDesktopSettings />);
    fireEvent.change(await screen.findByLabelText("Mode"), { target: { value: "managed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(confirm).toHaveBeenCalledWith("Changing the mode ends 1 running sandbox session. Continue?");
    expect(updateSandboxDesktopSettings).not.toHaveBeenCalled();
  });

  it("reports an image below the security floor as refused, with a security rebuild action", async () => {
    const insecure = status({ effectiveMode: "off", problem: "image-insecure", hint: "The image has a known security issue." });
    insecure.diagnostics.image = { ...insecure.diagnostics.image, secure: false, securityFloor: 0, requiredSecurityFloor: 1 };
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(insecure);
    render(<SandboxDesktopSettings />);
    expect((await screen.findByTestId("sandbox-diagnostic-image")).textContent).toContain("known security issue (security level 0, at least 1 required)");
    expect(screen.getByRole("button", { name: "Rebuild image (security fix)" })).toBeTruthy();
  });
});
