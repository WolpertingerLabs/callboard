/**
 * slash-commands.json is parsed JSON keyed by directory, and the directory is a
 * chat's folder — client input. A folder named `constructor` used to resolve to
 * Object.prototype's member, and `new Set(Object)` threw on every
 * GET /api/chats/:id/slash-commands for that chat.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-slash-commands-"));
process.env.CALLBOARD_DATA_DIR = join(tmpRoot, "data");
process.env.HOME = tmpRoot;

const { setSlashCommandsForDirectory, getCommandsAndPluginsForDirectory } = await import("./slashCommands.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getCommandsAndPluginsForDirectory — prototype-property directories", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"])("%j has no stored commands", (directory) => {
    setSlashCommandsForDirectory("/some/real/folder", ["review"]);
    expect(getCommandsAndPluginsForDirectory(directory).slashCommands.filter((c) => c === "review")).toEqual([]);
  });

  it("still returns a directory's own commands", () => {
    setSlashCommandsForDirectory("/some/real/folder", ["review"]);
    expect(getCommandsAndPluginsForDirectory("/some/real/folder").slashCommands).toContain("review");
  });
});
