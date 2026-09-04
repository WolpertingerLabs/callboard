import { describe, expect, it } from "vitest";
import { commonPathPrefix, splitPathForTruncation, stripPathPrefix } from "./pathTruncate";

describe("splitPathForTruncation", () => {
  it("keeps the last two segments out of the shrinking head", () => {
    expect(splitPathForTruncation("/home/cybil/some/deep/proj/callboard/frontend")).toEqual({
      head: "/home/cybil/some/deep/proj/",
      tail: "callboard/frontend",
    });
  });

  // The invariant every consumer leans on: the two halves render adjacent, so
  // concatenating them must give back exactly what was passed in.
  it.each(["/home/cybil/callboard.feat-wire-caps", "/home/cybil", "/home", "/", "/home/cybil/", "frontend/src/components/board", "callboard"])(
    "reassembles %s losslessly",
    (path) => {
      const { head, tail } = splitPathForTruncation(path);
      expect(head + tail).toBe(path);
    },
  );

  it("gives a two-segment path an empty head", () => {
    expect(splitPathForTruncation("/home/cybil")).toEqual({ head: "", tail: "/home/cybil" });
  });

  it("gives a one-segment path an empty head", () => {
    expect(splitPathForTruncation("/home")).toEqual({ head: "", tail: "/home" });
  });

  it("survives the root", () => {
    expect(splitPathForTruncation("/")).toEqual({ head: "", tail: "/" });
  });

  it("counts segments, not slashes, so a trailing slash does not fake a third segment", () => {
    expect(splitPathForTruncation("/home/cybil/")).toEqual({ head: "", tail: "/home/cybil/" });
    // On a deep path the trailing slash rides along on the tail.
    expect(splitPathForTruncation("/home/cybil/callboard/frontend/")).toEqual({
      head: "/home/cybil/",
      tail: "callboard/frontend/",
    });
  });

  it("handles a relative path", () => {
    expect(splitPathForTruncation("frontend/src/components")).toEqual({ head: "frontend/", tail: "src/components" });
    expect(splitPathForTruncation("src/components")).toEqual({ head: "", tail: "src/components" });
  });

  it("handles the empty string", () => {
    expect(splitPathForTruncation("")).toEqual({ head: "", tail: "" });
  });
});

describe("commonPathPrefix", () => {
  it("hoists the shared root out of the real mixed-depth fan-out", () => {
    // Straight from the live data: a 12-folder card whose members sit at
    // different depths under one home directory.
    expect(
      commonPathPrefix([
        "/home/cybil/.callboard/agent-workspaces/forge",
        "/home/cybil/countinghouse.feat-account-management",
        "/home/cybil/countinghouse.feat-analytics",
        "/home/cybil/countinghouse.feat-auth-deploy",
      ]),
    ).toBe("/home/cybil");
  });

  it("cuts at segment boundaries, not at characters", () => {
    // "countinghouse.feat-" is a shared substring; it is not a shared path.
    expect(commonPathPrefix(["/home/cybil/countinghouse.feat-analytics", "/home/cybil/countinghouse.feat-auth"])).toBe("/home/cybil");
  });

  it("stops one segment short so no row is left blank", () => {
    expect(commonPathPrefix(["/home/cybil", "/home/cybil/callboard"])).toBe("/home");
  });

  it("keeps a remainder even for duplicate paths, rather than hoisting the whole row away", () => {
    expect(commonPathPrefix(["/home/cybil", "/home/cybil"])).toBe("/home");
    // Nothing left to hoist once the shallowest path is a single segment.
    expect(commonPathPrefix(["/home", "/home"])).toBeNull();
  });

  it("returns null when there is nothing shared", () => {
    expect(commonPathPrefix(["/home/cybil/callboard", "/srv/deploy/callboard"])).toBeNull();
  });

  it("returns null below two paths — a prefix hoisted out of one row says nothing", () => {
    expect(commonPathPrefix(["/home/cybil/callboard"])).toBeNull();
    expect(commonPathPrefix([])).toBeNull();
  });

  it("refuses to mix absolute and relative paths", () => {
    expect(commonPathPrefix(["/home/cybil/callboard", "home/cybil/other"])).toBeNull();
  });

  it("works on relative paths", () => {
    expect(commonPathPrefix(["frontend/src/utils", "frontend/src/components"])).toBe("frontend/src");
  });
});

describe("stripPathPrefix", () => {
  it("removes the prefix and its separator", () => {
    expect(stripPathPrefix("/home/cybil/callboard", "/home/cybil")).toBe("callboard");
  });

  it("only strips at a segment boundary", () => {
    // Not "2": /home/cybil2 does not live under /home/cybil.
    expect(stripPathPrefix("/home/cybil2", "/home/cybil")).toBe("/home/cybil2");
  });

  it("leaves the path whole when the prefix is the path, absent, or unrelated", () => {
    expect(stripPathPrefix("/home/cybil", "/home/cybil")).toBe("/home/cybil");
    expect(stripPathPrefix("/home/cybil", undefined)).toBe("/home/cybil");
    expect(stripPathPrefix("/srv/app", "/home/cybil")).toBe("/srv/app");
  });
});
