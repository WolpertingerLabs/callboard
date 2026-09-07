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

/**
 * Adapter-vs-SDK item drift.
 *
 * `messageAdapter.ts` switches on `ThreadItem["type"]` with no `default` arm, so
 * an SDK bump that ADDS a member to that union produces a silent
 * `undefined` — the event is dropped and nothing says so. That is exactly the
 * failure this repo just spent a full investigation ruling out, and the cheapest
 * way to never repeat it is to assert the two sets still agree.
 *
 * The union is a type and therefore erased at runtime, so it is recovered from
 * the SDK's shipped `.d.ts`: the source of truth is the installed package, not a
 * list copied into this file that would drift alongside the code it guards.
 * Membership is then checked *behaviourally* — every declared type must
 * translate to something other than `undefined`.
 */
describe("messageAdapter ↔ SDK ThreadItem drift", () => {
  /** Item types the installed SDK declares as members of `ThreadItem`. */
  async function declaredItemTypes(): Promise<string[]> {
    const { existsSync, readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    // `require.resolve("@openai/codex-sdk")` throws here too — the package's
    // `exports` map defines no main Node will resolve from a test context (same
    // root cause as the package.json case asserted above). Walk up to the
    // installing `node_modules` instead, which is stable regardless of exports.
    let dir = dirname(fileURLToPath(import.meta.url));
    let dts: string | null = null;
    for (let i = 0; i < 10 && !dts; i++) {
      const candidate = join(dir, "node_modules", "@openai", "codex-sdk", "dist", "index.d.ts");
      if (existsSync(candidate)) dts = candidate;
      dir = dirname(dir);
    }
    if (!dts) throw new Error("could not locate @openai/codex-sdk dist/index.d.ts");
    const src = readFileSync(dts, "utf-8");

    const union = /type\s+ThreadItem\s*=\s*([^;]+);/.exec(src);
    if (!union) throw new Error("could not find `type ThreadItem = ...` in the SDK .d.ts");
    const members = union[1]!.split("|").map((s) => s.trim());

    return members.map((member) => {
      // Each member is an interface alias whose discriminant is a string literal.
      const decl = new RegExp(`type\\s+${member}\\s*=\\s*\\{[^}]*?type:\\s*"([^"]+)"`, "s").exec(src);
      if (!decl) throw new Error(`could not resolve the \`type\` literal for ThreadItem member ${member}`);
      return decl[1]!;
    });
  }

  it("recovers the union from the installed SDK, not from a hardcoded list", async () => {
    const types = await declaredItemTypes();
    // Sanity: the parse actually found members, so a silently-empty list can
    // never make the assertion below vacuous.
    expect(types.length).toBeGreaterThanOrEqual(8);
    expect(types).toContain("agent_message");
    expect(types).toContain("command_execution");
  });

  it("translates every item type the SDK declares", async () => {
    const { translateCodexEvent } = await import("./messageAdapter.js");
    const types = await declaredItemTypes();

    const unhandled: string[] = [];
    for (const type of types) {
      // A permissive item: the switch reads different fields per arm, and this
      // test is about reaching an arm at all, not about field mapping (which
      // messageAdapter.test.ts covers against real captures).
      const item = { id: "drift", type, command: "", changes: [], arguments: {}, query: "", items: [], message: "", text: "" };
      for (const phase of ["item.started", "item.updated", "item.completed"] as const) {
        const result = translateCodexEvent({ type: phase, item } as never);
        if (result === undefined) unhandled.push(`${phase}/${type}`);
      }
    }

    expect(unhandled).toEqual([]);
  });

  it("does not claim to handle compaction on the public lane", async () => {
    // `context_compaction` is NOT in `ThreadItem` for 0.153.4 — the CLI records
    // compactions only in the rollout. If a future SDK adds it, this fails and
    // the rollout tail's dedupe assumptions need revisiting (both paths would
    // then be live at once).
    const types = await declaredItemTypes();
    expect(types).not.toContain("context_compaction");
    expect(types).not.toContain("user_message");
  });
});
