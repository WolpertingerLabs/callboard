import { describe, expect, it } from "vitest";
import {
  SIDEBAR_FOLDER_MAX,
  applyStarredSidebarFolderDelta,
  includesSidebarFolder,
  isSidebarFolderEligible,
  parseSidebarFolder,
  readSidebarFolder,
} from "./sidebarFolder.js";

describe("parseSidebarFolder", () => {
  it("trims, and reads empty / whitespace / null / undefined as clear", () => {
    expect(parseSidebarFolder("  Work ")).toEqual({ ok: true, value: "Work" });
    for (const input of ["", "   ", null, undefined]) expect(parseSidebarFolder(input)).toEqual({ ok: true, value: null });
  });

  it("rejects non-strings, over-long names, control and invisible characters", () => {
    for (const input of [1, true, {}, [], "x".repeat(SIDEBAR_FOLDER_MAX + 1), "a\nb", "a\u0000b", "a\u009Fb", "a​b", "a‮b"]) {
      expect(parseSidebarFolder(input).ok, JSON.stringify(input)).toBe(false);
    }
    expect(parseSidebarFolder("x".repeat(SIDEBAR_FOLDER_MAX)).ok).toBe(true);
    // Ordinary unicode is fine.
    expect(parseSidebarFolder("Ünïcødé 📁")).toEqual({ ok: true, value: "Ünïcødé 📁" });
  });
});

describe("readSidebarFolder", () => {
  it("is a non-empty string or undefined", () => {
    expect(readSidebarFolder({ sidebarFolder: "Work" })).toBe("Work");
    for (const meta of [{}, { sidebarFolder: null }, { sidebarFolder: "  " }, { sidebarFolder: 3 }, null, undefined]) {
      expect(readSidebarFolder(meta as never)).toBeUndefined();
    }
  });
});

describe("isSidebarFolderEligible", () => {
  it("admits roots only", () => {
    expect(isSidebarFolderEligible({}, "a")).toBe(true);
    expect(isSidebarFolderEligible({ rootChatId: "a" }, "a")).toBe(true);
    expect(isSidebarFolderEligible({ rootChatId: "r" }, "a")).toBe(false);
    expect(isSidebarFolderEligible({ parentChatId: "p" }, "a")).toBe(false);
    expect(isSidebarFolderEligible({ forkedFrom: "f" }, "a")).toBe(false);
  });
});

describe("starred folders", () => {
  it("includesSidebarFolder matches case-insensitively", () => {
    expect(includesSidebarFolder(["Work"], "WORK")).toBe(true);
    expect(includesSidebarFolder(["Work"], "Wörk")).toBe(false);
  });

  it("appends adds, skipping any spelling already starred", () => {
    expect(applyStarredSidebarFolderDelta(["Work"], { add: ["Side", "work", "side"] })).toEqual(["Work", "Side"]);
  });

  it("removes every spelling a remove matches, and ignores one that is not there", () => {
    expect(applyStarredSidebarFolderDelta(["Work", "Alpha"], { remove: ["WORK", "never"] })).toEqual(["Alpha"]);
  });

  it("treats a name in both as an add", () => {
    expect(applyStarredSidebarFolderDelta(["Work", "Alpha"], { add: ["work"], remove: ["Work"] })).toEqual(["Alpha", "work"]);
  });

  it("drops invalid names from the delta and from what is stored", () => {
    expect(applyStarredSidebarFolderDelta(["Work", "bad\u0007", "work"], { add: ["  Side  ", "", 7, "x".repeat(SIDEBAR_FOLDER_MAX + 1)] })).toEqual(["Work", "Side"]);
  });
});
