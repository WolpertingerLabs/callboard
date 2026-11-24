/**
 * The Sandbox desktop's operator settings and diagnostics
 * (`GET/PUT /api/sandbox-desktop`), and the lifecycle fields the Computer view
 * reads off `ComputerUseCapability.sandbox` / `ComputerUseSession.container`.
 *
 * Everything here is REST, not `stream.ts`, and every field is optional or
 * new: an older bundle ignores what it does not know. The string sets below
 * are new fields' own values, never new members of an existing enum.
 */

/**
 * - `off`: no sandbox target (it probes as turned off).
 * - `managed`: Callboard starts one container per session on the local Docker,
 *   and removes it when the session ends.
 * - `endpoint`: a driver host you run yourself, named by
 *   `CALLBOARD_SANDBOX_DESKTOP_URL` and `CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE`.
 */
export type SandboxDesktopMode = "off" | "managed" | "endpoint";
/** `internet`: outbound access (the default). `none`: an `--internal` network with no route off the bridge. */
export type SandboxDesktopNetwork = "internet" | "none";

/** What is stored. An omitted field takes its default; an omitted `mode` is automatic. */
export interface SandboxDesktopSettings {
  mode?: SandboxDesktopMode;
  network?: SandboxDesktopNetwork;
  /** CPUs per sandbox. */
  cpus?: number;
  /** Memory per sandbox, in MiB (no swap beyond it). */
  memoryMb?: number;
  /** Managed sandboxes running at once, across all chats. */
  maxConcurrent?: number;
}

/** Bounds and defaults, shared so the form and the server agree. */
export const SANDBOX_DESKTOP_BOUNDS = {
  cpus: { min: 0.5, max: 8, default: 1 },
  memoryMb: { min: 512, max: 16384, default: 1024 },
  maxConcurrent: { min: 1, max: 8, default: 2 },
} as const;

/** The one-time image build, for docs and messages. */
export const SANDBOX_BUILD_COMMAND = "callboard sandbox build";

/** Something worth fixing that does not stop a sandbox starting. */
export type SandboxDesktopWarning = "image-outdated";

/** Why a managed sandbox cannot start right now. */
export type SandboxDesktopProblem = "turned-off" | "docker-unreachable" | "image-missing" | "image-incompatible" | "network" | "cap-reached" | "endpoint-unset";

export interface SandboxDesktopDiagnostics {
  docker: { reachable: boolean; version?: string; error?: string };
  image: {
    name: string;
    present: boolean;
    /** The image's `dev.callboard.computer-use.protocol` label. */
    protocol?: string;
    /** The image's `org.opencontainers.image.version` label. */
    version?: string;
    /** Its protocol major is the one this Callboard speaks. */
    compatible: boolean;
    /** The protocol this Callboard speaks, `"<major>.<minor>"`. */
    expectedProtocol: string;
    /** The computer-use package version this Callboard ships; an image built from another is worth rebuilding. */
    packageVersion: string;
    /** Built from exactly the files this Callboard ships (its content label matches). False: out of date, still starts. */
    current?: boolean;
    /** The image's `dev.callboard.computer-use.content` label, and the digest a current image carries. */
    content?: string;
    expectedContent?: string;
  };
  network: { name: string; internal: boolean; state: "ok" | "missing" | "misconfigured" | "unknown"; detail?: string };
  /** Managed sandboxes: this daemon's live ones, the cap, and labelled containers of this owner that Docker lists. */
  running: { sessions: number; limit: number; containers?: number };
  endpoint: { configured: boolean; url?: string };
}

export interface SandboxDesktopBuild {
  state: "idle" | "running" | "succeeded" | "failed";
  startedAt?: number;
  finishedAt?: number;
  /** The last few KB of `docker build` output. */
  output?: string;
  error?: string;
}

export interface SandboxDesktopStatus {
  settings: SandboxDesktopSettings;
  /** The mode in force: the stored one, or for an automatic setting, what it resolves to now. */
  effectiveMode: SandboxDesktopMode;
  /** `settings.mode` is unset, so the mode follows the environment (see the README). */
  automatic: boolean;
  /** Present when the effective mode cannot start a sandbox. */
  problem?: SandboxDesktopProblem;
  /** One line of setup guidance for `problem`. */
  hint?: string;
  /** A soft finding: the sandbox still starts, but something is worth fixing (an out-of-date image). */
  warning?: SandboxDesktopWarning;
  warningHint?: string;
  diagnostics: SandboxDesktopDiagnostics;
  build: SandboxDesktopBuild;
  buildCommand: string;
  /** Whether this caller may change settings or build (a signed-in session; never an API key). */
  canEdit: boolean;
  /** This daemon's owner label value, derived from its data directory. */
  owner: string;
}

/** The sandbox part of the Computer view's sandbox capability. */
export interface ComputerUseSandboxInfo {
  mode: SandboxDesktopMode;
  /** Managed mode: the network new sandboxes get. */
  network?: SandboxDesktopNetwork;
  problem?: SandboxDesktopProblem;
  hint?: string;
  /** Managed mode: a soft finding (it still starts), with what to do. */
  warning?: SandboxDesktopWarning;
  warningHint?: string;
  /** Managed mode: sandboxes running now, and the cap. */
  running?: number;
  limit?: number;
}

/** A managed sandbox session's container, for the Computer view. */
export interface ComputerUseContainerState {
  phase: "starting" | "ready" | "stopping" | "removed";
  /** While starting: which step, in words ("Starting the container", "Waiting for the desktop"). */
  step?: string;
}
