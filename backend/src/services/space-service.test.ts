/**
 * Filing new chats into spaces, and the per-space session inputs (system
 * prompt instructions, plugin/MCP/skill scope).
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-space-service-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("./claude.js", () => ({ getActiveSession: () => undefined, hasPendingRequest: () => false, getPendingRequest: () => null }));
const appPlugins = vi.hoisted(() => ({
  plugins: [] as any[],
  servers: [] as any[],
}));
vi.mock("./app-plugins.js", () => ({
  getEnabledAppPlugins: () => appPlugins.plugins,
  getEnabledMcpServers: () => appPlugins.servers,
}));

const { resolveNewChatSpace, spaceOfChat, spaceInstructionsPrompt } = await import("./space-service.js");
const { createSpace, updateSpace, getSpace } = await import("./space-store.js");
const { chatFileService } = await import("./chat-file-service.js");
const { buildPluginOptions, buildMcpServerOptions } = await import("./claude-session-options.js");
const { customSkillsService } = await import("./custom-skills-service.js");

const work = createSpace({ name: "Work", folderRules: ["/rules/**"] });
const personal = createSpace({ name: "Personal" });

describe("resolveNewChatSpace", () => {
  it("a tree to join wins over the caller's choice and the folder rules", () => {
    const root = chatFileService.createChat("/rules/x", "root-1", JSON.stringify({ spaceId: personal.id }));
    expect(resolveNewChatSpace({ treeRootId: root.id, requested: work.id, folder: "/rules/x" })).toBe(personal.id);
  });

  it("then the caller's explicit live space", () => {
    expect(resolveNewChatSpace({ requested: personal.id, folder: "/rules/x" })).toBe(personal.id);
  });

  it("ignores an unknown or archived request and falls back to folder rules, then the default", () => {
    const old = createSpace({ name: "Old" });
    updateSpace(old.id, { archived: true });
    expect(resolveNewChatSpace({ requested: old.id, folder: "/rules/x" })).toBe(work.id);
    expect(resolveNewChatSpace({ requested: "sp_nope", folder: "/elsewhere" })).toBe("default");
  });
});

describe("spaceOfChat", () => {
  it("answers with the root's space for any member", () => {
    const root = chatFileService.createChat("/a", "root-2", JSON.stringify({ spaceId: work.id }));
    const child = chatFileService.createChat("/a", "child-2", JSON.stringify({ parentChatId: root.id, rootChatId: root.id }));
    expect(spaceOfChat(child.id)).toBe(work.id);
    expect(spaceOfChat(undefined)).toBe("default");
  });
});

describe("spaceInstructionsPrompt", () => {
  it("is empty without instructions and names the space when present", () => {
    expect(spaceInstructionsPrompt(getSpace(work.id))).toBe("");
    updateSpace(work.id, { instructions: "Always cite ticket numbers." });
    const prompt = spaceInstructionsPrompt(getSpace(work.id));
    expect(prompt).toContain('"Work" space');
    expect(prompt).toContain("Always cite ticket numbers.");
    expect(spaceInstructionsPrompt(null)).toBe("");
  });
});

describe("agent scope", () => {
  it("filters app plugins and their MCP servers to the space's allowlist", () => {
    appPlugins.plugins = [
      { id: "p-slack", pluginPath: "/plugins/slack", manifest: { name: "slack" } },
      { id: "p-git", pluginPath: "/plugins/git", manifest: { name: "git" } },
    ];
    appPlugins.servers = [
      { name: "slack", type: "http", url: "http://x", sourcePluginId: "p-slack", enabled: true },
      { name: "git", type: "http", url: "http://y", sourcePluginId: "p-git", enabled: true },
    ];
    expect(buildPluginOptions("/tmp", undefined).map((p) => p.name)).toEqual(["slack", "git"]);
    expect(buildPluginOptions("/tmp", undefined, { plugins: ["p-git"] }).map((p) => p.name)).toEqual(["git"]);
    expect(Object.keys(buildMcpServerOptions({ plugins: ["p-git"] })!.mcpServers)).toEqual(["git"]);
    expect(Object.keys(buildMcpServerOptions()!.mcpServers)).toEqual(["slack", "git"]);
  });

  it("exposes only the allowed custom skills through a scoped plugin dir", () => {
    customSkillsService.createSkill({ name: "alpha", description: "Alpha skill", content: "body a" });
    customSkillsService.createSkill({ name: "beta", description: "Beta skill", content: "body b" });
    const full = customSkillsService.getPluginDir();
    const scoped = customSkillsService.getPluginDir(["beta"]);
    expect(full).not.toBeNull();
    expect(scoped).not.toBe(full);
    expect(readdirSync(join(scoped!, "skills"))).toEqual(["beta"]);
    expect(existsSync(join(scoped!, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(customSkillsService.getPluginDir(["nonexistent"])).toBeNull();
  });
});
