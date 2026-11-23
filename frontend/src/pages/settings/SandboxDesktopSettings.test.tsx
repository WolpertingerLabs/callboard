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
afterEach(cleanup);

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

  it("saves a change, sending automatic as null", async () => {
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ settings: { mode: "off" }, automatic: false, effectiveMode: "off" }));
    vi.mocked(updateSandboxDesktopSettings).mockResolvedValue(status({ settings: { network: "none", maxConcurrent: 3 } }));
    render(<SandboxDesktopSettings />);
    fireEvent.change(await screen.findByLabelText("Mode"), { target: { value: "auto" } });
    fireEvent.change(screen.getByLabelText("Network (managed)"), { target: { value: "none" } });
    fireEvent.change(screen.getByLabelText("Sandboxes at once"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSandboxDesktopSettings).toHaveBeenCalledWith({ mode: null, network: "none", cpus: 1, memoryMb: 1024, maxConcurrent: 3 }));
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
});
