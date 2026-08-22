/**
 * Command injection through the ignored-project-dir prefixes, closed and pinned.
 *
 * ## What it was
 *
 * `_discoverPaginated` built a shell command string and ran it through
 * `execSync`, interpolating `getIgnoredProjectDirPrefixes()` — which comes from
 * `~/.callboard/ignored-project-dirs.json`, written over HTTP by
 * `PUT /api/ignored-project-dirs`, which validated only "an array of strings".
 * So any authenticated client could run a command on the daemon's machine, and
 * a client reaching the daemon through Remote Access has a password as the only
 * barrier. Demonstrated end to end against an isolated daemon:
 *
 *     PUT /api/ignored-project-dirs {"prefixes":["evil$(id > /tmp/proof)"]} → 200
 *     GET /api/chats                                                        → 200
 *     cat /tmp/proof → uid=1001(cybil) gid=1002(cybil) …
 *
 * ## What is asserted here
 *
 * Both layers, because either alone would close it and neither alone should be
 * relied on:
 *
 *  1. the spawn takes an **argv array** with no shell, so a prefix has nothing
 *     to escape into — asserted by driving real discovery with a malicious
 *     prefix already on disk and checking the side effect never happens;
 *  2. the prefix is **validated on both the write and the read path**, so a
 *     value like that cannot be stored, and a hand-edited file cannot smuggle
 *     one back in.
 *
 * The side-effect file is the assertion rather than a string comparison on a
 * command line: a test that checks the command *text* would still pass if
 * someone reintroduced a shell somewhere else in the chain.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-injection-"));
const CONFIG = join(DATA_DIR, "ignored-project-dirs.json");
const PROOF = join(DATA_DIR, "injection-proof.txt");

// Must be set before anything imports `utils/paths.js`, which reads it at
// module scope.
process.env.CALLBOARD_DATA_DIR = DATA_DIR;

/**
 * Layer 2 is *mocked out* for the layer-1 cases, and that is the whole design of
 * this file.
 *
 * With validation live on the read path the payload never reaches `find` at all,
 * so a layer-1 test would pass whether or not a shell was in the chain — it
 * would be asserting that layer 2 works, twice. Overriding the getter forces the
 * malicious value all the way down to the spawn, which is the only way to test
 * the thing layer 1 is for.
 */
const mocks = vi.hoisted(() => ({ prefixes: null as string[] | null }));

vi.mock("../../../utils/paths.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../utils/paths.js")>();
  return {
    ...real,
    getIgnoredProjectDirPrefixes: () => mocks.prefixes ?? real.getIgnoredProjectDirPrefixes(),
  };
});

const { saveIgnoredProjectDirPrefixes, isValidIgnoredPrefix, CLAUDE_PROJECTS_DIR } = await import("../../../utils/paths.js");
const { ClaudeCodeSessionProvider } = await import("./ClaudeCodeSessionProvider.js");

/** The payload, spelled so a shell would create PROOF and an argv array would not. */
const PAYLOAD = `evil$(touch ${PROOF})`;
const BACKTICK_PAYLOAD = "evil`touch " + PROOF + "`";

function forgetPrefixCache() {
  // `saveIgnoredProjectDirPrefixes` refreshes the module cache; calling it with
  // the defaults is the supported way to drop whatever a case put there.
  saveIgnoredProjectDirPrefixes(["-tmp"]);
}

beforeEach(() => {
  rmSync(PROOF, { force: true });
  mocks.prefixes = null;
  forgetPrefixCache();
});

afterEach(() => {
  rmSync(PROOF, { force: true });
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  delete process.env.CALLBOARD_DATA_DIR;
});

describe("layer 1 — the spawn has no shell", () => {
  it.each([
    ["$(…) substitution", PAYLOAD],
    ["backtick substitution", BACKTICK_PAYLOAD],
  ])("does not execute a %s that reaches the spawn", (_label, payload) => {
    // Validation bypassed on purpose — this layer has to hold on its own, for
    // the hand-edited file, the restored backup, the future writer that forgets.
    mocks.prefixes = [payload];

    if (!existsSync(CLAUDE_PROJECTS_DIR)) mkdirSync(CLAUDE_PROJECTS_DIR, { recursive: true });
    // Real discovery, the way `GET /api/chats` reaches it.
    new ClaudeCodeSessionProvider().discoverSessions({ limit: 1, offset: 0 });

    expect(existsSync(PROOF), "the payload executed — a shell is back in the chain").toBe(false);
  });
});

describe("layer 2 — the prefix is validated on both paths", () => {
  it("refuses to store a prefix outside the slug charset", () => {
    // Project dirs are slugified paths, so such a prefix could never match one
    // anyway; dropping it costs nothing real.
    expect(saveIgnoredProjectDirPrefixes([PAYLOAD, "-tmp"])).toEqual(["-tmp"]);
  });

  it("drops one that is already on disk, rather than trusting the file", async () => {
    writeFileSync(CONFIG, JSON.stringify({ prefixes: [PAYLOAD, "-private-"] }));

    // A fresh module registry, because the read is memoized and no exported
    // reset drops it — and a cached answer would test nothing about the file.
    // `importActual` so this is the real getter rather than the layer-1
    // override.
    vi.resetModules();
    const fresh = await vi.importActual<typeof import("../../../utils/paths.js")>("../../../utils/paths.js");

    expect(fresh.getIgnoredProjectDirPrefixes()).toEqual(["-private-"]);
  });

  it("still accepts every prefix that can actually match a project dir", () => {
    // The guard must not cost the feature. These are the built-in defaults and
    // the shape a real slugified dir name takes.
    for (const ok of ["-tmp", "-private-", "-home-cybil-scratch", "abc123", "-a-b-c"]) {
      expect(isValidIgnoredPrefix(ok), ok).toBe(true);
    }
    for (const bad of ["", " ", "a b", "a/b", "a$b", "a`b", "a;b", "a\nb", "a|b"]) {
      expect(isValidIgnoredPrefix(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
