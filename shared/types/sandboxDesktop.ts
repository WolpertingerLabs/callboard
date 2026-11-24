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
  /** How long a container whose final outbox copy failed is kept (paused) for recovery, in hours. */
  keepHours?: number;
  /**
   * Containers kept for recovery at once, across all chats (0: never keep;
   * remove on a failed copy). Separate from `maxConcurrent`: a kept one is
   * paused (no CPU) but still holds its memory.
   */
  maxKept?: number;
  /**
   * Disk all chats' deliverables may use together, in GiB. Past it new files
   * are refused (and reported); nothing delivered is deleted to make room.
   */
  deliverablesGb?: number;
  /**
   * Caps on what a sandbox profile's recipe may ask for (its `limits`). A
   * profile's CPUs, memory, home size and session length are the recipe's,
   * each clamped to these; a recipe that omits one gets the base sandbox's
   * value (`cpus`, `memoryMb`, a 512 MiB home, 15 minutes).
   */
  profileMaxCpus?: number;
  profileMaxMemoryMb?: number;
  profileMaxHomeMb?: number;
  profileMaxSessionMinutes?: number;
}

/** Bounds and defaults, shared so the form and the server agree. */
export const SANDBOX_DESKTOP_BOUNDS = {
  cpus: { min: 0.5, max: 8, default: 1 },
  memoryMb: { min: 512, max: 16384, default: 1024 },
  maxConcurrent: { min: 1, max: 8, default: 2 },
  keepHours: { min: 1, max: 168, default: 24 },
  maxKept: { min: 0, max: 8, default: 2 },
  deliverablesGb: { min: 1, max: 1024, default: 5 },
  profileMaxCpus: { min: 0.5, max: 32, default: 4 },
  profileMaxMemoryMb: { min: 512, max: 65536, default: 8192 },
  profileMaxHomeMb: { min: 256, max: 65536, default: 4096 },
  profileMaxSessionMinutes: { min: 5, max: 480, default: 120 },
} as const;

/** The base sandbox's home size and session length, which a profile that does not ask for its own gets. */
export const SANDBOX_BASE_HOME_MB = 512;
export const SANDBOX_BASE_SESSION_MINUTES = 15;

/** The one-time image build, for docs and messages. */
export const SANDBOX_BUILD_COMMAND = "callboard sandbox build";
/** A profile's build: `${SANDBOX_PROFILE_BUILD_COMMAND} <name>`. */
export const SANDBOX_PROFILE_BUILD_COMMAND = "callboard sandbox build --profile";

/** A sandbox profile's resources, after the Settings caps. */
export interface SandboxProfileLimits {
  cpus: number;
  memoryMb: number;
  /** The desktop user's tmpfs home (the outbox included). */
  homeMb: number;
  sessionMinutes: number;
}

/**
 * A profile image's state, for Settings and `callboard sandbox profiles`:
 * - `missing`: not built.
 * - `current`: built from this recipe on the current base.
 * - `outdated`: the recipe or the base changed since (see `outdatedBy`); it still starts.
 * - `insecure`: below a security floor (the base's or the profile compiler's); refused until rebuilt.
 * - `incompatible`: another protocol major; refused until rebuilt.
 */
export type SandboxProfileState = "missing" | "current" | "outdated" | "insecure" | "incompatible";

/** One sandbox profile: its recipe's summary, its effective limits and its image. */
export interface SandboxProfileStatus {
  name: string;
  description: string;
  /** Where the recipe comes from. Today only `builtin` (shipped with Callboard). */
  source: "builtin";
  gl: "none" | "software";
  /** What the recipe asks for (absent: the base sandbox's value). */
  requested: Partial<SandboxProfileLimits>;
  /** What a session gets: the request, clamped to the Settings caps. */
  limits: SandboxProfileLimits;
  /** The limits the caps reduced. */
  clamped?: (keyof SandboxProfileLimits)[];
  /** The recipe digest a current image carries. */
  digest: string;
  /** What the build installs, for review: Debian packages and pinned downloads. */
  packages: string[];
  downloads: { url: string; sha256: string; dest: string }[];
  image: { name: string; state: SandboxProfileState; outdatedBy?: ("recipe" | "base")[]; detail?: string; builtAt?: string; sizeBytes?: number };
}

/** A sandbox session's profile, for the Computer view and the consent card. Absent: the base sandbox. */
export interface ComputerUseSandboxProfile {
  name: string;
  description?: string;
  gl?: "none" | "software";
  limits?: SandboxProfileLimits;
}

/** Something worth fixing that does not stop a sandbox starting. */
export type SandboxDesktopWarning = "image-outdated";

/** Why a managed sandbox cannot start right now. */
export type SandboxDesktopProblem =
  | "turned-off"
  | "docker-unreachable"
  | "image-missing"
  | "image-incompatible"
  /** Below the image security floor, or without the label: refused until rebuilt. */
  | "image-insecure"
  | "network"
  | "cap-reached"
  | "endpoint-unset";

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
    /** Its security level label, and whether it meets this Callboard's floor (below it, the image is refused). */
    securityFloor?: number;
    secure?: boolean;
    requiredSecurityFloor?: number;
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
  /** The profile being (or last) built; absent: the base image. */
  profile?: string;
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
  /** The sandbox profiles this Callboard knows, with their image state. Absent from an older daemon. */
  profiles?: SandboxProfileStatus[];
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
  /** `kept`: the session ended, but a drain hook kept the container for recovery (it is not removed yet). */
  phase: "starting" | "ready" | "stopping" | "removed" | "kept";
  /** While starting: which step, in words ("Starting the container", "Waiting for the desktop"). */
  step?: string;
}

/**
 * Deliverables: files an agent (or the human) saved to `~/outbox` inside a
 * Sandbox desktop, copied to this machine while the session runs and once
 * more before a managed container is removed. `GET
 * /api/computer-use/:chatId/deliverables`; REST only, never on the stream.
 */
export const SANDBOX_OUTBOX_LIMITS = {
  /** Largest single file (the driver host and client enforce the same). */
  fileBytes: 64 * 1024 * 1024,
  /** All files delivered from one session, every version counted. */
  sessionBytes: 256 * 1024 * 1024,
  /** Files delivered from one session, every version counted. */
  sessionFiles: 100,
} as const;

/** One delivered file. `path` is its absolute path on the Callboard host. */
export interface SandboxDeliveredFile {
  sessionId: string;
  /** The name in the outbox. */
  name: string;
  /** The name it was stored under: `name`, or `name (2).ext` for a later version. */
  storedName: string;
  path: string;
  size: number;
  sha256: string;
  deliveredAt: number;
  /** How the chat renders it (the render_file media types). */
  mediaType: "image" | "audio" | "video" | "pdf" | "file";
  mimeType: string;
}

/** A file that was not copied because it is over a limit. */
export interface SandboxDeliveryRefusal {
  name: string;
  size: number;
  /** The first reason it was refused for; it does not change while the same file stays refused. */
  reason: "too-large" | "session-total" | "file-count" | "storage-full";
}

export interface SandboxSessionDeliveries {
  sessionId: string;
  mode: "managed" | "endpoint";
  /**
   * `live`: the session is running and being synced. `complete`: its final
   * copy matched every listed file. `incomplete`: it did not (see `problem`).
   */
  state: "live" | "complete" | "incomplete";
  startedAt: number;
  endedAt?: number;
  files: SandboxDeliveredFile[];
  refused: SandboxDeliveryRefusal[];
  /** Why the final copy is incomplete, in words. */
  problem?: string;
  /**
   * The container was removed before every file was copied: discarded by the
   * human, its retention ended, it vanished (Docker or the machine
   * restarted), or it was never kept because the Settings limit of kept
   * containers was reached. A new field of this PR; a value an older bundle
   * does not know shows its generic "not every file was copied" line.
   */
  lost?: "discarded" | "expired" | "gone" | "not-kept";
  /**
   * Present when this session is another chat's, shown here because this
   * chat's history was copied from it (Continue from, Rerun, Compress, a
   * fork or an aside): only its files delivered by the copy point.
   */
  fromChatId?: string;
}

/** A managed container whose final copy failed: paused, not removed, until `expiresAt`. */
export interface SandboxKeptContainer {
  sessionId: string;
  keptAt: number;
  expiresAt: number;
  reason: string;
  /** A retry is running now. */
  retrying?: boolean;
}

export interface SandboxDeliveriesResponse {
  sessions: SandboxSessionDeliveries[];
  kept: SandboxKeptContainer[];
}

/** `POST /api/computer-use/:chatId/kept/:sessionId/retry`. */
export interface SandboxKeptRetryResult {
  /** `removed`: everything was copied and the container is gone. `kept`: still incomplete, still kept. `gone`: the container no longer exists. */
  outcome: "removed" | "kept" | "gone";
  reason?: string;
}
