import { homedir } from "node:os";
import { getAgentWorkspacePath } from "./agent-file-service.js";

interface SessionLocation {
  folder?: string;
  agentAlias?: string;
}

/** Execution and preflight share precedence. The result is a template until
 * the runner interpolates it with its run context, not a daemon cwd fallback. */
export function resolveJobSessionFolder(step: SessionLocation, defaults: SessionLocation): string {
  const agentAlias = step.agentAlias ?? defaults.agentAlias;
  return step.folder ?? defaults.folder ?? (agentAlias ? getAgentWorkspacePath(agentAlias) : homedir());
}
