/**
 * Helpers for pointing the ACP adapter at the {@link file://./fake-acp-agent.ts
 * test double}.
 *
 * The double is a `.ts` file, which bare `node` cannot execute, so it runs
 * through tsx's loader — the same trick `toolAdapter.ts` uses for the MCP shim.
 * Centralizing that here keeps every test from repeating the invocation and
 * means a change to how the double is launched is a one-line edit.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpVendorPreset } from "../vendors.js";
import type { FakeAcpScenario } from "./fake-acp-agent.js";

/** Absolute path to the test double. */
export function fakeAcpAgentPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "fake-acp-agent.ts");
}

/**
 * A vendor preset that spawns the test double running `scenario`.
 *
 * Passed to the adapter as `options.acp.preset` — the same inline-preset seam
 * Phase 3's user-defined providers will use — so nothing global is mutated and
 * tests can run in parallel with different scenarios.
 */
export function acpTestAgentPreset(scenario: FakeAcpScenario, overrides: Partial<AcpVendorPreset> = {}): AcpVendorPreset {
  return {
    id: "test-double",
    label: `Fake ACP agent (${scenario})`,
    command: [process.execPath, "--import", "tsx", fakeAcpAgentPath(), scenario],
    ...overrides,
  };
}
