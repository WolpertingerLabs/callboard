// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { parseStandaloneParams, requestedAccess, standaloneArtifactHref } from "./artifactStandalone";
import { clearArtifactWriteGrants, getArtifactWriteGrant, saveArtifactWriteGrant } from "../utils/localStorage";

/**
 * The standalone page's URL and its remembered write opt-in. The URL shape has
 * no place for an access level, in either direction: the parser returns none,
 * the href builder takes none.
 */

const q = (s: string) => new URLSearchParams(s);

describe("parseStandaloneParams", () => {
  it("refuses a path under the artifact, whatever the query", () => {
    expect(parseStandaloneParams("cramhouse", q("key=birds"), "x/y")).toEqual({ ok: false, reason: expect.stringContaining('no page at "/x/y"') });
    expect(parseStandaloneParams("cramhouse", q("key=birds"), "").ok).toBe(true);
  });

  it("reads id, key and v", () => {
    expect(parseStandaloneParams("cramhouse", q("key=birds&v=3"))).toEqual({ ok: true, artifactId: "cramhouse", storageKey: "birds", version: 3 });
    expect(parseStandaloneParams("cramhouse", q(""))).toEqual({ ok: true, artifactId: "cramhouse", storageKey: null, version: null });
    expect(parseStandaloneParams("cramhouse", q("key=&v="))).toEqual({ ok: true, artifactId: "cramhouse", storageKey: null, version: null });
  });

  it("has nowhere to put an access level: write/access parameters change nothing", () => {
    const plain = parseStandaloneParams("cramhouse", q("key=birds"));
    for (const extra of ["write=1", "access=readwrite", "storage_access=readwrite", "allow=1&rw=true"]) {
      expect(parseStandaloneParams("cramhouse", q(`key=birds&${extra}`))).toEqual(plain);
    }
  });

  it.each([
    [undefined, ""],
    ["", ""],
    ["Bad", ""],
    ["../x", ""],
    ["a".repeat(65), ""],
    ["cramhouse", "key=../etc"],
    ["cramhouse", "key=.."],
    ["cramhouse", "key=a%2Fb"],
    ["cramhouse", "key=Birds"],
    ["cramhouse", `key=${"a".repeat(65)}`],
    ["cramhouse", "v=0"],
    ["cramhouse", "v=-1"],
    ["cramhouse", "v=1.5"],
    ["cramhouse", "v=1e3"],
    ["cramhouse", "v=0x10"],
    ["cramhouse", "v=9999999999"],
    ["cramhouse", "v=99999999999999999999"],
  ])("refuses id %s with %s", (id, search) => {
    expect(parseStandaloneParams(id, q(search)).ok).toBe(false);
  });
});

describe("standaloneArtifactHref", () => {
  it("carries only id, key and version", () => {
    expect(standaloneArtifactHref("cramhouse")).toBe("/a/cramhouse");
    expect(standaloneArtifactHref("cramhouse", { storageKey: "birds" })).toBe("/a/cramhouse?key=birds");
    expect(standaloneArtifactHref("cramhouse", { storageKey: "birds", version: 4 })).toBe("/a/cramhouse?key=birds&v=4");
    expect(standaloneArtifactHref("cramhouse", { storageKey: null, version: 4 })).toBe("/a/cramhouse?v=4");
  });

  it("round-trips through the parser", () => {
    const href = standaloneArtifactHref("cramhouse", { storageKey: "birds.v2_x-1", version: 12 });
    const url = new URL(href, "http://x");
    expect(parseStandaloneParams(url.pathname.split("/")[2], url.searchParams)).toEqual({ ok: true, artifactId: "cramhouse", storageKey: "birds.v2_x-1", version: 12 });
  });
});

describe("requestedAccess", () => {
  it.each([
    ["readwrite", "birds", false, "read"],
    ["readwrite", "birds", true, "readwrite"],
    ["read", "birds", true, "read"],
    ["read", "birds", false, "read"],
    ["none", "birds", true, "none"],
    ["readwrite", null, true, "none"],
  ] as const)("declared %s, key %s, remembered %s → %s", (declared, key, allowed, expected) => {
    expect(requestedAccess(declared, key, allowed)).toBe(expected);
  });
});

describe("remembered write grants", () => {
  beforeEach(() => localStorage.clear());
  const C = "2026-09-01T00:00:00.000Z";

  it("default is not granted; saving is per (artifact, key)", () => {
    expect(getArtifactWriteGrant("cramhouse", C, "birds")).toBe(false);
    saveArtifactWriteGrant("cramhouse", C, "birds", true);
    expect(getArtifactWriteGrant("cramhouse", C, "birds")).toBe(true);
    expect(getArtifactWriteGrant("cramhouse", C, "trees")).toBe(false);
    expect(getArtifactWriteGrant("other", C, "birds")).toBe(false);
    saveArtifactWriteGrant("cramhouse", C, "birds", false);
    expect(getArtifactWriteGrant("cramhouse", C, "birds")).toBe(false);
    expect(JSON.parse(localStorage.getItem("claude-code-settings")!).artifactWriteGrants).toEqual({});
  });

  it("is bound to the artifact's identity: the same id recreated (a new `created`) is not granted", () => {
    saveArtifactWriteGrant("cramhouse", C, "birds", true);
    expect(getArtifactWriteGrant("cramhouse", "2026-09-30T00:00:00.000Z", "birds")).toBe(false);
    expect(getArtifactWriteGrant("cramhouse", "", "birds")).toBe(false);
    // Nothing is remembered without an identity to bind it to.
    saveArtifactWriteGrant("cramhouse", "", "trees", true);
    expect(JSON.parse(localStorage.getItem("claude-code-settings")!).artifactWriteGrants).toEqual({ "cramhouse/birds": C });
  });

  it("keeps the rest of the settings blob and other grants", () => {
    localStorage.setItem("claude-code-settings", JSON.stringify({ themeMode: "dark", artifactWriteGrants: { "a/b": C } }));
    saveArtifactWriteGrant("cramhouse", C, "birds", true);
    expect(JSON.parse(localStorage.getItem("claude-code-settings")!)).toEqual({ themeMode: "dark", artifactWriteGrants: { "a/b": C, "cramhouse/birds": C } });
  });

  it("only the matching identity string counts, and invalid names are neither read nor written", () => {
    localStorage.setItem("claude-code-settings", JSON.stringify({ artifactWriteGrants: { "cramhouse/birds": true, "x/y": 1 } }));
    expect(getArtifactWriteGrant("cramhouse", C, "birds")).toBe(false);
    expect(getArtifactWriteGrant("x", "1", "y")).toBe(false);
    saveArtifactWriteGrant("cramhouse", C, "../birds", true);
    saveArtifactWriteGrant("Cram/house", C, "birds", true);
    expect(Object.keys(JSON.parse(localStorage.getItem("claude-code-settings")!).artifactWriteGrants)).toEqual(["cramhouse/birds", "x/y"]);
  });

  it("clearArtifactWriteGrants forgets one artifact's grants on every key, and nothing else — not even an id it prefixes", () => {
    saveArtifactWriteGrant("cram", C, "birds", true);
    saveArtifactWriteGrant("cram", C, "trees", true);
    saveArtifactWriteGrant("cramhouse", C, "birds", true);
    clearArtifactWriteGrants("cram");
    expect(getArtifactWriteGrant("cram", C, "birds")).toBe(false);
    expect(getArtifactWriteGrant("cram", C, "trees")).toBe(false);
    expect(getArtifactWriteGrant("cramhouse", C, "birds")).toBe(true);
  });

  it("clearArtifactWriteGrants with keepCreated drops only the id's grants from another identity", () => {
    const NEW = "2026-09-30T00:00:00.000Z";
    localStorage.setItem("claude-code-settings", JSON.stringify({ artifactWriteGrants: { "cram/birds": C, "cram/trees": NEW, "cram/old": true, "cramhouse/birds": C } }));
    clearArtifactWriteGrants("cram", NEW);
    expect(JSON.parse(localStorage.getItem("claude-code-settings")!).artifactWriteGrants).toEqual({ "cram/trees": NEW, "cramhouse/birds": C });
  });
});
