import type { PermissionLevel } from "./permissions.js";

/**
 * The tool name the per-action computer-control confirmation is raised under,
 * on every engine — that is, in a chat whose `computerControl` is `ask`; under
 * `allow` no per-action confirmation is raised. Initial enablement always
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
 * `cu_action` (the bare spelling is what the cline/pi custom-tool bridges use)
 * would borrow this panel's chrome while its other inputs — a `command`, say —
 * went unrendered behind a server-chosen `summary`.
 */
export const CU_ACTION_TOOL_NAME = "mcp__computer_use__cu_action";

/** Only host-issued human-only prompts with this exact name may render the enablement security card. */
export const CU_REQUEST_CONTROL_TOOL_NAME = "mcp__computer_use__cu_request_control";

/** Callboard HTTP viewer DTOs. Driver/package types stay outside shared. */
export type ComputerUseKind = "browser" | "native";
export interface ComputerUseCapability {
  kind: ComputerUseKind;
  available: boolean;
  reason?: string;
  /** Additive viewer guidance; older/custom probes may omit this. Never infer from reason. */
  readiness?: "setup-required" | "unsupported" | "permission-blocked" | "unknown";
}
export interface ComputerUseSession {
  id: string;
  kind: ComputerUseKind;
  state: string;
  controller: "agent" | "human" | null;
  generation: number;
  targetLabel?: string;
  reason?: string;
}
export interface ComputerUseStatus {
  capabilities: ComputerUseCapability[];
  sessions: ComputerUseSession[];
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
