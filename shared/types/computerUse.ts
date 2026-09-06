import type { PermissionLevel } from "./permissions.js";

/** Callboard HTTP viewer DTOs. Driver/package types stay outside shared. */
export type ComputerUseKind = "browser" | "native";
export interface ComputerUseCapability {
  kind: ComputerUseKind;
  available: boolean;
  reason?: string;
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
