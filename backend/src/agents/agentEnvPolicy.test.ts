import { describe, it, expect } from "vitest";
import {
  CALLBOARD_AGENT_ENV_EXCLUSIONS,
  isExcludedAgentEnvKey,
  sanitizeInheritedAgentEnv,
} from "./agentEnvPolicy.js";

describe("agentEnvPolicy", () => {
  it("excludes callboard/drawlatch server-internal vars", () => {
    for (const key of [
      "AUTH_PASSWORD_HASH",
      "AUTH_PASSWORD_SALT",
      "NODE_ENV",
      "PORT",
      "INSTANCE_NAME",
      "CALLBOARD_DATA_DIR",
      "MCP_PROXY_MODE",
      "EVENT_WATCHER_REMOTE_URL",
    ]) {
      expect(isExcludedAgentEnvKey(key)).toBe(true);
    }
  });

  it("excludes whole prefix families (drawlatch / event-watcher)", () => {
    expect(isExcludedAgentEnvKey("DRAWLATCH_TUNNEL")).toBe(true);
    expect(isExcludedAgentEnvKey("DRAWLATCH_SOMETHING_NEW")).toBe(true);
    expect(isExcludedAgentEnvKey("EVENT_WATCHER_ANYTHING")).toBe(true);
  });

  it("keeps vars the agent subprocess needs and generic host vars", () => {
    for (const key of ["PATH", "HOME", "CODEX_HOME", "XDG_DATA_HOME", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]) {
      expect(isExcludedAgentEnvKey(key)).toBe(false);
    }
  });

  it("sanitizes a process.env-shaped object without mutating the input", () => {
    const input = {
      PATH: "/usr/bin",
      HOME: "/home/cybil",
      NODE_ENV: "production",
      PORT: "8000",
      AUTH_PASSWORD_HASH: "deadbeef",
      DRAWLATCH_PORT: "9999",
      OPENAI_BASE_URL: "https://example",
    };
    const out = sanitizeInheritedAgentEnv(input);

    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/home/cybil", OPENAI_BASE_URL: "https://example" });
    // input untouched
    expect(input.NODE_ENV).toBe("production");
    expect(input.AUTH_PASSWORD_HASH).toBe("deadbeef");
  });

  it("keeps the record free of accidental duplicates", () => {
    expect(new Set(CALLBOARD_AGENT_ENV_EXCLUSIONS).size).toBe(CALLBOARD_AGENT_ENV_EXCLUSIONS.length);
  });
});
