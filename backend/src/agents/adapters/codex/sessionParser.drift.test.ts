/**
 * The rollout `cli_version` drift warning, and specifically its latch.
 *
 * The warning existed but latched on a single boolean: the first non-matching
 * version any rollout carried silenced it for the life of the process. That is
 * backwards at exactly the moment it matters — right after an
 * `EXPECTED_CODEX_CLI_VERSION` bump *every* rollout already on disk is stale
 * (374 of them on the machine this was measured on, spanning 0.139.0 /
 * 0.146.0 / 0.146.1), so the single warning was always spent on an old version
 * and a genuinely newer rollout arriving later logged nothing at all.
 *
 * Latching per distinct version keeps the total bounded by how many CLI
 * versions ever wrote to the machine — noise, not spam — while making each
 * distinct drift visible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn() }));

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({ warn: mocks.warn, debug: mocks.debug, info: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../../services/agent-settings.js", () => ({ getAgentSettings: () => ({}) }));

import { EXPECTED_CODEX_CLI_VERSION, parseCodexRollout, resetCodexCliVersionWarnings } from "./sessionParser.js";

const THREAD_ID = "019ec7f2-cd5d-7823-b2d1-6683c42bfe32";
let dir: string;

/** Write a minimal rollout whose only interesting field is `cli_version`. */
function rolloutWith(cliVersion: string, name: string): string {
  const p = join(dir, `rollout-2026-06-14T17-03-58-${name}${THREAD_ID.slice(name.length)}.jsonl`);
  const lines = [
    { type: "session_meta", payload: { id: THREAD_ID, cwd: "/p", timestamp: "2026-06-14T17:03:58.000Z", cli_version: cliVersion } },
    { type: "response_item", payload: { type: "message", role: "user", content: "hi" } },
  ];
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-drift-"));
  resetCodexCliVersionWarnings();
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetCodexCliVersionWarnings();
});

describe("rollout cli_version drift warning", () => {
  it("stays quiet on the version the parser targets", () => {
    parseCodexRollout(rolloutWith(EXPECTED_CODEX_CLI_VERSION, "a"));
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("warns once, not per file, for a repeated stale version", () => {
    parseCodexRollout(rolloutWith("0.139.0", "a"));
    parseCodexRollout(rolloutWith("0.139.0", "b"));
    parseCodexRollout(rolloutWith("0.139.0", "c"));
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(String(mocks.warn.mock.calls[0][0])).toContain("0.139.0");
  });

  it("still warns for a NEW version after an older one already warned", () => {
    parseCodexRollout(rolloutWith("0.139.0", "a"));
    parseCodexRollout(rolloutWith("0.199.0", "b"));
    expect(mocks.warn).toHaveBeenCalledTimes(2);
    expect(String(mocks.warn.mock.calls[1][0])).toContain("0.199.0");
  });
});
