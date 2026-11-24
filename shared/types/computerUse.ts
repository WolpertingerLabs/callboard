import type { PermissionLevel } from "./permissions.js";
import type { ComputerUseContainerState, ComputerUseSandboxInfo } from "./sandboxDesktop.js";

/**
 * The tool name the per-action computer-control confirmation is raised under,
 * on every engine — that is, when the target's axis (`browserControl` for the
 * browser, `computerControl` for the desktop, `sandboxControl` for the sandbox
 * desktop) is `ask`; under `allow` no
 * per-action confirmation is raised. Initial enablement always
 * requires human consent under both policies (CU_REQUEST_CONTROL_TOOL_NAME).
 *
 * Shared because both sides of one contract need the *same* string and neither
 * may widen it. The backend raises exactly this name
 * (`ComputerUseHost.requestAgentAction`); the chat's prompt panel grants the
 * computer-control presentation — a dedicated header, and a body that renders
 * only `summary` + `action` — to exactly this name and nothing else.
 *
 * Do NOT match it loosely on the frontend. The backend's
 * `isComputerControlToolName` deliberately accepts several spellings, but that
 * matching is deny-side: recognizing more names gates more calls. Here the same
 * looseness would be trust-side, and a third-party MCP server exposing its own
 * `cu_action` (the bare spelling is what the pi custom-tool bridge uses)
 * would borrow this panel's chrome while its other inputs — a `command`, say —
 * went unrendered behind a server-chosen `summary`.
 */
export const CU_ACTION_TOOL_NAME = "mcp__computer_use__cu_action";

/** Only host-issued human-only prompts with this exact name may render the enablement security card. */
export const CU_REQUEST_CONTROL_TOOL_NAME = "mcp__computer_use__cu_request_control";

/**
 * How Callboard describes the Sandbox desktop — to the human (consent card,
 * per-action card, permission row, Computer view) and to the agent (tool
 * descriptions). One place, because the truth depends on how the container
 * is run, which is a host setting (Settings → Sandbox desktop):
 *
 * - **managed**: Callboard starts a fresh container for each session and
 *   removes it, with everything in it, when the session ends. Its network is
 *   the internet (default) or none (`network: "none"`, an `--internal`
 *   network); either way it can reach services on this machine that listen on
 *   all interfaces.
 * - **endpoint** (and anything unknown — an older daemon, a surface that does
 *   not know the mode): one operator-run container shared by every chat and
 *   kept until it is restarted, so NOT fresh per session and NOT a place for
 *   work other chats must not see. The strictest description is the fallback.
 *
 * A surface that cannot know the mode uses {@link SANDBOX_DESKTOP_TEXT_ANY_MODE}.
 * (The permission row itself keeps to one short line; the full text lives on
 * the consent card and in the agent guide.)
 */
export interface SandboxDesktopVariant {
  mode?: "managed" | "endpoint" | "off";
  network?: "internet" | "none";
}
export interface SandboxDesktopText {
  /** What it is, as a phrase: "the Sandbox desktop is …". */
  what: string;
  /** What it can reach. Shown on the consent card and wherever the network is mentioned. */
  network: string;
  /** When to choose it. */
  use: string;
  /** What survives a session, as a sentence. */
  persistence: string;
  /** How to hand files back to this machine (the outbox), as sentences. */
  outbox: string;
}
const OPEN_NETWORK = "Its network is open: it can reach the internet, and any service on this machine that listens on all interfaces, Callboard included.";
/**
 * The outbox convention, the same in every mode: the driver host lists only
 * plain names (`[A-Za-z0-9_][A-Za-z0-9._-]*`), so a `.name.part` file is
 * invisible until it is renamed, and a file still changing is not copied yet.
 */
const OUTBOX =
  "To hand a file back to this machine, save it in ~/outbox (/home/desktop/outbox) inside the sandbox: write it as ~/outbox/.NAME.part, then rename it to its final plain name (letters, digits, '.', '_' or '-'; no spaces, no subfolders). Callboard copies finished files to this machine while the session runs and once more when it ends, and shows them in the chat; cu_status and cu_stop list them with their paths here. No other file leaves the sandbox.";
const NO_INTERNET = "It has no internet access, but it can still reach any service on this machine that listens on all interfaces, Callboard included.";
export function sandboxDesktopText(variant: SandboxDesktopVariant = {}): SandboxDesktopText {
  if (variant.mode === "managed")
    return {
      what: "a Linux desktop in a hardened container, isolated from this machine's files and credentials; Callboard starts a fresh one for each session and removes it, with everything in it, when the session ends",
      network: variant.network === "none" ? NO_INTERNET : OPEN_NETWORK,
      use: "Use it for desktop apps and downloads that should stay off this machine.",
      persistence:
        "Nothing in it carries over to another session: the container and everything in it are removed when the session ends. Only the files in ~/outbox are copied to this machine first; if that copy fails, the container is paused and kept for a while (a day by default) so the copy can be retried, then removed.",
      outbox: OUTBOX,
    };
  return {
    what: "a Linux desktop in a hardened container, isolated from this machine's files and credentials, but shared by every chat and kept until the container is restarted",
    network: OPEN_NETWORK,
    use: "Use it for desktop apps and downloads that should stay off this machine.",
    persistence: "Whatever is left there, later sessions and other chats can see.",
    outbox: `${OUTBOX} Only files new or changed during your session are copied, and they stay in the shared outbox afterwards.`,
  };
}
/** The shared-container (endpoint) description: the fallback wherever the mode is unknown. */
export const SANDBOX_DESKTOP_TEXT: SandboxDesktopText = Object.freeze(sandboxDesktopText({ mode: "endpoint" }));
/** For a surface that cannot know the host's mode. True of both modes. */
export const SANDBOX_DESKTOP_TEXT_ANY_MODE: SandboxDesktopText = Object.freeze({
  what: "a Linux desktop in a hardened container, isolated from this machine's files and credentials (a fresh one per session when Callboard manages it, or a shared one you run yourself)",
  network:
    "Its network is open by default: it can reach the internet, and in any setting any service on this machine that listens on all interfaces, Callboard included.",
  use: "Use it for desktop apps and downloads that should stay off this machine.",
  persistence: "A shared container you run yourself keeps what is left there for later sessions and other chats.",
  outbox: OUTBOX,
});

/**
 * Callboard HTTP viewer DTOs. Driver/package types stay outside shared.
 *
 * `"sandbox"` (the Sandbox desktop: a desktop in a hardened container, not
 * the user's machine) is a later enum value. A client that has
 * a `switch` on this cannot be assumed to handle it, so the daemon sends
 * sandbox capabilities, sessions and prompts only to a client that advertises
 * `CLIENT_CAPS.sandboxTarget` (shared/types/protocol.ts) — on the status REST
 * endpoint and on the stream alike.
 */
export type ComputerUseKind = "browser" | "native" | "sandbox";
export interface ComputerUseCapability {
  kind: ComputerUseKind;
  available: boolean;
  reason?: string;
  /** Additive viewer guidance; older/custom probes may omit this. Never infer from reason. */
  readiness?: "setup-required" | "unsupported" | "permission-blocked" | "unknown";
  /**
   * The level of the axis that governs this target (`browserControl` for
   * `browser`, `computerControl` for `native`, `sandboxControl` for
   * `sandbox`). Additive; older daemons omit
   * it, in which case fall back to `ComputerUseStatus.permission`.
   */
  permission?: PermissionLevel;
  /** Sandbox only: its mode, and why a managed sandbox cannot start (Docker, image, cap). Additive. */
  sandbox?: ComputerUseSandboxInfo;
}
export interface ComputerUseSession {
  id: string;
  kind: ComputerUseKind;
  state: string;
  controller: "agent" | "human" | null;
  generation: number;
  targetLabel?: string;
  reason?: string;
  /** A managed sandbox's container: starting (with the step), ready, stopping, removed. Additive. */
  container?: ComputerUseContainerState;
}
export interface ComputerUseStatus {
  capabilities: ComputerUseCapability[];
  sessions: ComputerUseSession[];
  /**
   * The most permissive of the chat's control levels for the targets this
   * client is sent — `browserControl` and `computerControl`, plus
   * `sandboxControl` for a client with `CLIENT_CAPS.sandboxTarget` — i.e. "does
   * any target shown accept enabling". Per-target levels are on
   * `ComputerUseCapability.permission`.
   */
  permission: PermissionLevel;
  events?: { sessionId: string; generation: number; type: string; at: number }[];
}
export interface ComputerUseFrame {
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}
export interface ComputerUseObservation {
  frameId: string;
  frame: ComputerUseFrame;
  generation: number;
}
export type ComputerUseAction =
  | { type: "click"; x: number; y: number; button: "left" | "right" }
  | { type: "move"; x: number; y: number }
  | { type: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { type: "scroll"; deltaX: number; deltaY: number }
  | { type: "key"; key: string }
  | { type: "type"; text: string }
  | { type: "navigate"; url: string };
export interface ComputerUseActionRequest {
  action: ComputerUseAction;
  expectedGeneration: number;
  frameId: string;
  requestId: string;
}
