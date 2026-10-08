import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-space-store-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const store = await import("./space-store.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(join(tmpRoot, "spaces"), { recursive: true, force: true });
  store._resetSpaceStoreCache();
});

describe("space store", () => {
  it("has a virtual default space called General, written to nothing", () => {
    const spaces = store.listSpaces();
    expect(spaces.map((s) => [s.id, s.name])).toEqual([["default", "General"]]);
    expect(() => readdirSync(join(tmpRoot, "spaces"))).toThrow();
  });

  it("creates spaces in switcher order after the default", () => {
    const a = store.createSpace({ name: "Work", emoji: "💼" });
    const b = store.createSpace({ name: "Personal" });
    expect(a.id).toMatch(/^sp_/);
    expect(store.listSpaces().map((s) => s.name)).toEqual(["General", "Work", "Personal"]);
    expect(b.order).toBeGreaterThan(a.order);
  });

  it("PATCH is a delta: absent keys are kept and null clears", () => {
    const s = store.createSpace({ name: "Work", emoji: "💼", instructions: "Be terse.", folderRules: ["~/work/**"] });
    store.updateSpace(s.id, { name: "Day job" });
    let now = store.getSpace(s.id)!;
    expect(now).toMatchObject({ name: "Day job", emoji: "💼", instructions: "Be terse.", folderRules: ["~/work/**"] });
    store.updateSpace(s.id, { emoji: null, instructions: null });
    now = store.getSpace(s.id)!;
    expect(now.emoji).toBeUndefined();
    expect(now.instructions).toBeUndefined();
    expect(now.folderRules).toEqual(["~/work/**"]);
  });

  it("merges defaults key by key so two tabs editing different defaults both land", () => {
    const s = store.createSpace({ name: "Work" });
    store.updateSpace(s.id, { defaults: { provider: "codex" } });
    store.updateSpace(s.id, { defaults: { worktreeByDefault: true } });
    expect(store.getSpace(s.id)!.defaults).toEqual({ provider: "codex", worktreeByDefault: true });
    store.updateSpace(s.id, { defaults: { provider: null } });
    expect(store.getSpace(s.id)!.defaults).toEqual({ worktreeByDefault: true });
  });

  it("normalises default permissions and caps recent directories", () => {
    const s = store.createSpace({ name: "Work" });
    const dirs = Array.from({ length: 15 }, (_, i) => ({ path: `/repo/${i}`, lastUsed: "2026-01-01" }));
    store.updateSpace(s.id, { defaults: { recentDirectories: dirs, defaultPermissions: { fileRead: "allow" } as any } });
    const d = store.getSpace(s.id)!.defaults!;
    expect(d.recentDirectories).toHaveLength(10);
    expect(d.defaultPermissions?.fileRead).toBe("allow");
    expect(d.defaultPermissions?.computerControl).toBe("deny");
  });

  it("refuses invalid input with a SpaceValidationError", () => {
    expect(() => store.createSpace({ name: "  " })).toThrow(store.SpaceValidationError);
    expect(() => store.createSpace({ name: "evil‮name" })).toThrow(store.SpaceValidationError);
    const s = store.createSpace({ name: "Ok" });
    expect(() => store.updateSpace(s.id, { color: "#ff0000" as any })).toThrow(/color/);
    expect(() => store.updateSpace(s.id, { instructions: "x".repeat(5000) })).toThrow(/limited/);
    expect(() => store.updateSpace(s.id, { defaults: { provider: "openrouter" as any } })).toThrow(/provider/);
    expect(() => store.updateSpace("default", { archived: true })).toThrow(/default/);
    expect(() => store.deleteSpaceRecord("default")).toThrow(/default/);
  });

  it("lets the default space be renamed, materialising its file", () => {
    store.updateSpace("default", { name: "Inbox" });
    expect(store.listSpaces()[0]).toMatchObject({ id: "default", name: "Inbox" });
  });

  it("hides archived spaces unless asked", () => {
    const s = store.createSpace({ name: "Old" });
    store.updateSpace(s.id, { archived: true });
    expect(store.listSpaces().some((x) => x.id === s.id)).toBe(false);
    expect(store.listSpaces({ includeArchived: true }).some((x) => x.id === s.id)).toBe(true);
  });

  it("normalises unknown stamps to the default", () => {
    const s = store.createSpace({ name: "Work" });
    expect(store.normalizeSpaceId(s.id)).toBe(s.id);
    expect(store.normalizeSpaceId("sp_gone")).toBe("default");
    expect(store.normalizeSpaceId(undefined)).toBe("default");
  });

  it("rejects ids that could escape the directory", () => {
    expect(store.isValidSpaceId("../x")).toBe(false);
    expect(store.getSpace("../../etc/passwd")).toBeNull();
    expect(store.deleteSpaceRecord("sp_../x")).toBe(false);
  });
});

describe("folder rules", () => {
  it("matches plain paths as 'this directory and below'", () => {
    const m = store.compileFolderRule("/home/u/work");
    expect(m("/home/u/work")).toBe(true);
    expect(m("/home/u/work/repo")).toBe(true);
    expect(m("/home/u/workshop")).toBe(false);
  });

  it("supports * within a segment, ** across segments, and ~", () => {
    expect(store.compileFolderRule("/src/*/app")("/src/a/app")).toBe(true);
    expect(store.compileFolderRule("/src/*/app")("/src/a/b/app")).toBe(false);
    expect(store.compileFolderRule("/src/**")("/src/a/b/c")).toBe(true);
    expect(store.compileFolderRule("/src/**")("/src")).toBe(true);
    expect(store.compileFolderRule("~/work/**")(join(homedir(), "work", "x"))).toBe(true);
  });

  it("picks the first matching live space, else the default", () => {
    const a = store.createSpace({ name: "A", folderRules: ["/repos/a/**"] });
    const b = store.createSpace({ name: "B", folderRules: ["/repos/**"] });
    expect(store.spaceForFolder("/repos/a/x")).toBe(a.id);
    expect(store.spaceForFolder("/repos/z")).toBe(b.id);
    expect(store.spaceForFolder("/other")).toBe("default");
    expect(store.spaceForFolder(undefined)).toBe("default");
    store.updateSpace(a.id, { archived: true });
    expect(store.spaceForFolder("/repos/a/x")).toBe(b.id);
  });
});
