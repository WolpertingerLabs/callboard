/**
 * The boot-time rollout-format drift check — the one that had never fired.
 *
 * ## Why this file exists at all
 *
 * `CodexSessionProvider.checkSdkVersionOnce` read the installed SDK version
 * with `require("@openai/codex-sdk/package.json")`. That package ships an
 * `exports` map with no `"./package.json"` entry, so the require threw
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` — on every boot, on every machine — straight
 * into a bare `catch` documented as "SDK not resolvable (tests / partial
 * install)". The warning it exists to emit had therefore never been seen by
 * anyone, and could not be, for the entire life of the Codex adapter.
 *
 * That warning is not decoration. `sessionParser.ts` hand-decodes an
 * undocumented, version-dependent JSONL format; a change to it does not throw,
 * it silently drops messages from a resumed chat. The check is the only thing
 * that would make such a change diagnosable.
 *
 * So the assertions below are about **firing**, in both directions, and the
 * latch is reset between them — because the previous cut of this check would
 * have passed any test that only asserted "no warning on a matching version".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn(), packageVersion: vi.fn() }));

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({ warn: mocks.warn, debug: mocks.debug, info: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../../utils/package-version.js", () => ({ bundledPackageVersion: mocks.packageVersion }));

vi.mock("../../../services/agent-settings.js", () => ({ getAgentSettings: () => ({}) }));

import { CodexSessionProvider, resetCodexSdkDriftWarning } from "./CodexSessionProvider.js";
import { EXPECTED_CODEX_CLI_VERSION } from "./sessionParser.js";

beforeEach(() => {
  resetCodexSdkDriftWarning();
  vi.clearAllMocks();
});

afterEach(() => {
  resetCodexSdkDriftWarning();
});

describe("checkSdkVersionOnce", () => {
  it("warns when the installed SDK differs from the version the parser targets", () => {
    mocks.packageVersion.mockReturnValue("0.999.0");

    new CodexSessionProvider();

    expect(mocks.packageVersion).toHaveBeenCalledWith("@openai/codex-sdk");
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const message = String(mocks.warn.mock.calls[0][0]);
    expect(message).toContain("0.999.0");
    expect(message).toContain(EXPECTED_CODEX_CLI_VERSION);
    expect(message).toContain("rollout format may have drifted");
  });

  it("stays silent when the versions match", () => {
    mocks.packageVersion.mockReturnValue(EXPECTED_CODEX_CLI_VERSION);
    new CodexSessionProvider();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("warns once per process, however many providers are constructed", () => {
    // The latch is why this went unnoticed: the check runs from a constructor
    // and a suite can otherwise only ever observe the first provider built.
    mocks.packageVersion.mockReturnValue("0.999.0");
    new CodexSessionProvider();
    new CodexSessionProvider();
    new CodexSessionProvider();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it("skips quietly — and only skips — when the version genuinely cannot be read", () => {
    // This is what the old bare `catch` claimed to be doing while it was in
    // fact swallowing an exception thrown on every single boot. Now the skip is
    // a real branch with a real cause, and it is debug rather than warn: an
    // unreadable manifest is not evidence of drift.
    mocks.packageVersion.mockReturnValue(undefined);
    new CodexSessionProvider();
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.debug).toHaveBeenCalledTimes(1);
  });

  it("does not use the require() pattern that could never work", async () => {
    // A guard against reintroducing it. `require("@openai/codex-sdk/package.json")`
    // throws ERR_PACKAGE_PATH_NOT_EXPORTED against the real installed tree, so
    // any check built on it is dead on arrival — proven here rather than
    // asserted in a comment.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    expect(() => require("@openai/codex-sdk/package.json")).toThrowError(/ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/);
  });
});
