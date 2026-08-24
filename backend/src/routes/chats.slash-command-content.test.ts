/**
 * Route-level tests for GET /api/chats/:id/slash-commands/content.
 *
 * The route exists because a slash command's *body* is expensive and almost
 * never wanted: the composer chips a command on sight and only reads it if the
 * user opens the popover. So the contract has three halves worth pinning.
 *
 *  - It resolves the same three kinds of name the composer can offer — custom
 *    skill, per-directory plugin command, app-wide plugin command — off real
 *    files on disk, not a mocked discovery layer. A fake here would pass while
 *    the marketplace-relative `source` hop was wrong.
 *  - A name it cannot resolve is a harness built-in, which is a real command
 *    with no readable body. That answers 200 with `content: null`; 404 would
 *    make the popover claim the command doesn't exist.
 *  - It takes a user-supplied string and reads a file with it. A name carrying
 *    a path separator is refused before anything is resolved, and the read is
 *    additionally fenced inside the plugin's own commands/ directory.
 *
 * Same no-supertest style as chats.preview.test.ts: the handler is pulled off
 * the router stack and driven with a fake req/res.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-cmd-content-"));
process.env.CALLBOARD_DATA_DIR = DATA_DIR;

/** A project checkout carrying its own marketplace + plugin. */
const PROJECT_DIR = mkdtempSync(join(tmpdir(), "callboard-cmd-project-"));
/** An app-wide plugin, registered in app-plugins.json rather than discovered. */
const APP_PLUGIN_DIR = mkdtempSync(join(tmpdir(), "callboard-cmd-appplugin-"));

const SKILL_BODY = "Do the thing, then do it again.";
const PLUGIN_BODY = "# Build the thing\n\nRun the build.";
const APP_PLUGIN_BODY = "# Deploy the thing\n\nShip it.";
const SECRET_BODY = "TOPSECRET-ONE-LEVEL-UP\n";
const OUTSIDE_BODY = "root:x:0:0:root:/root:/bin/bash\n";

function write(path: string, contents: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf-8");
}

// ── Custom skill: callboard:my-skill ────────────────────────────────────────
write(join(DATA_DIR, "custom-skills", "skills", "my-skill", "SKILL.md"), `---\nname: "my-skill"\ndescription: "A skill of mine"\n---\n\n${SKILL_BODY}\n`);

// ── Per-directory plugin: proj:build ────────────────────────────────────────
// `link` is the same plugin reached through a symlinked directory — it must
// still resolve, which is why containment is checked between *real* paths on
// both sides rather than only on the file.
write(
  join(PROJECT_DIR, ".claude-plugin", "marketplace.json"),
  JSON.stringify({
    plugins: [
      { name: "proj", source: "./plugins/proj", description: "Project plugin" },
      { name: "link", source: "./plugins/linked", description: "Same plugin, symlinked dir" },
    ],
  }),
);
write(join(PROJECT_DIR, "plugins", "proj", "commands", "build.md"), PLUGIN_BODY);
// A file the traversal guard must never reach, one hop above commands/.
write(join(PROJECT_DIR, "plugins", "proj", "secret.md"), SECRET_BODY);

// A file outside the checkout entirely — stand-in for /etc/passwd or ~/.ssh/id_*.
const OUTSIDE_FILE = join(mkdtempSync(join(tmpdir(), "callboard-cmd-outside-")), "passwd");
writeFileSync(OUTSIDE_FILE, OUTSIDE_BODY, "utf-8");

/**
 * A repo can ship symlinks, and `resolve()` does not follow them: a lexical
 * containment check passes for `commands/pw.md -> /etc/passwd` because the
 * *link* is inside commands/. Clone such a repo, open it, pick the command,
 * and the popover renders the target. These three links are that attack.
 */
symlinkSync(OUTSIDE_FILE, join(PROJECT_DIR, "plugins", "proj", "commands", "pw.md"));
symlinkSync(join(PROJECT_DIR, "plugins", "proj", "secret.md"), join(PROJECT_DIR, "plugins", "proj", "commands", "leak.md"));
symlinkSync("../secret.md", join(PROJECT_DIR, "plugins", "proj", "commands", "relleak.md"));
// A link that stays inside commands/ is legitimate and must keep working.
symlinkSync(join(PROJECT_DIR, "plugins", "proj", "commands", "build.md"), join(PROJECT_DIR, "plugins", "proj", "commands", "alias.md"));
symlinkSync(join(PROJECT_DIR, "plugins", "proj"), join(PROJECT_DIR, "plugins", "linked"));

// ── App-wide plugin: appkit:deploy (enabled) and offkit:deploy (disabled) ────
write(join(APP_PLUGIN_DIR, "commands", "deploy.md"), APP_PLUGIN_BODY);
write(join(APP_PLUGIN_DIR, "commands", "hidden.md"), "HIDDEN");
writeFileSync(
  join(DATA_DIR, "app-plugins.json"),
  JSON.stringify({
    scanRoots: [],
    plugins: [
      {
        id: "app-1",
        pluginPath: APP_PLUGIN_DIR,
        marketplacePath: join(APP_PLUGIN_DIR, ".claude-plugin", "marketplace.json"),
        scanRoot: APP_PLUGIN_DIR,
        manifest: { name: "appkit", description: "App kit", source: "./appkit" },
        commands: [{ name: "deploy", description: "Deploy it" }],
        enabled: true,
      },
      {
        id: "app-2",
        pluginPath: APP_PLUGIN_DIR,
        marketplacePath: join(APP_PLUGIN_DIR, ".claude-plugin", "marketplace.json"),
        scanRoot: APP_PLUGIN_DIR,
        manifest: { name: "offkit", description: "Disabled kit", source: "./offkit" },
        commands: [{ name: "hidden", description: "Hidden" }],
        enabled: false,
      },
    ],
  }),
  "utf-8",
);

const CHAT = {
  id: "chat-1",
  folder: PROJECT_DIR,
  session_id: "session-1",
  metadata: "{}",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getAllChats: () => [CHAT],
    getChat: (id: string) => (id === CHAT.id ? CHAT : null),
  },
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getPendingRequest: () => null, getActiveSession: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
vi.mock("../utils/git.js", () => ({
  getGitInfo: () => ({ isGitRepo: false }),
  resolveBranch: () => ({ ok: true, folder: PROJECT_DIR }),
  resolveWorktreeToMainRepoCached: (folder: string) => ({ mainRepoPath: folder }),
}));
vi.mock("../services/card-store.js", () => ({ getCard: () => null, listCards: () => [] }));
vi.mock("../agents/factory.js", () => ({ getSessionProviders: () => [{ kind: "claude-code", resolveSession: () => null }] }));

const { chatsRouter } = await import("./chats.js");
const { readCommandFile } = await import("../services/plugins.js");

const routeHandler = (path: string) =>
  (chatsRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods.get).route.stack[0].handle as (
    req: Request,
    res: Response,
  ) => void;

const byChat = routeHandler("/:id/slash-commands/content");
const byFolder = routeHandler("/new/slash-commands/content");

/**
 * Per-directory plugin ids the composer would report as switched on — ids here
 * are the manifest names (see discoverPlugins). The parameter is the client's
 * own view of what is on screen, not a credential.
 */
const ACTIVE = ["proj", "link"];

interface Answer {
  status: number;
  body: any;
}

function drive(handler: (req: Request, res: Response) => void, req: Partial<Request>): Promise<Answer> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: any) {
        resolve({ status: this.statusCode, body });
        return this;
      },
    };
    handler(req as Request, res as unknown as Response);
  });
}

function fetchContent(name: string | undefined, opts: { id?: string; activePlugins?: string[] } = {}): Promise<Answer> {
  const { id = CHAT.id, activePlugins = ACTIVE } = opts;
  return drive(byChat, { params: { id }, query: { ...(name === undefined ? {} : { name }), activePlugins } } as unknown as Partial<Request>);
}

function fetchContentByFolder(name: string | undefined, opts: { folder?: string; activePlugins?: string[] } = {}): Promise<Answer> {
  const { folder = PROJECT_DIR, activePlugins = ACTIVE } = opts;
  return drive(byFolder, {
    query: { ...(name === undefined ? {} : { name }), ...(folder === undefined ? {} : { folder }), activePlugins },
  } as unknown as Partial<Request>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/chats/:id/slash-commands/content", () => {
  it("returns a custom skill's full SKILL.md body", async () => {
    const { status, body } = await fetchContent("callboard:my-skill");
    expect(status).toBe(200);
    expect(body).toEqual({ name: "callboard:my-skill", source: "custom-skill", description: "A skill of mine", content: SKILL_BODY });
  });

  it("returns a per-directory plugin command's body from the chat's folder", async () => {
    const { status, body } = await fetchContent("proj:build");
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: "proj:build", source: "plugin", content: PLUGIN_BODY });
    // Description comes from the same first-line convention discovery uses.
    expect(body.description).toBe("Build the thing");
  });

  it("returns an enabled app-wide plugin command's body", async () => {
    const { status, body } = await fetchContent("appkit:deploy");
    expect(status).toBe(200);
    expect(body).toEqual({ name: "appkit:deploy", source: "plugin", description: "Deploy it", content: APP_PLUGIN_BODY });
  });

  it("treats a harness built-in as a real command with no readable body", async () => {
    const { status, body } = await fetchContent("compact");
    expect(status).toBe(200);
    expect(body).toEqual({ name: "compact", source: "builtin", description: null, content: null });
  });

  it("answers 200 with no content for names nothing owns", async () => {
    // Unknown namespace, unknown command in a known namespace, and a command
    // belonging to a plugin the user disabled — none of these are errors.
    for (const name of ["nosuch:thing", "proj:nosuch", "callboard:nosuch", "offkit:hidden"]) {
      const { status, body } = await fetchContent(name);
      expect(status).toBe(200);
      expect(body).toMatchObject({ name, source: "builtin", content: null });
    }
  });

  it("refuses a name that carries a path", async () => {
    for (const name of ["proj:../secret", "callboard:../../etc/passwd", "../../etc/passwd", "proj:..\\secret", "proj:build\0"]) {
      const { status, body } = await fetchContent(name);
      expect(status).toBe(400);
      expect(body.content).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("SECRET");
    }
  });

  it("does not serve a command file that symlinks out of the plugin", async () => {
    for (const name of ["proj:pw", "proj:leak", "proj:relleak"]) {
      const { status, body } = await fetchContent(name);
      expect(status).toBe(200);
      expect(body).toMatchObject({ name, source: "builtin", content: null });
      expect(JSON.stringify(body)).not.toContain("TOPSECRET");
      expect(JSON.stringify(body)).not.toContain("root:x:0:0");
    }
  });

  it("serves a command reached through a symlinked plugin directory", async () => {
    const { status, body } = await fetchContent("link:build");
    expect(status).toBe(200);
    expect(body).toMatchObject({ source: "plugin", content: PLUGIN_BODY });
  });

  it("requires a name", async () => {
    expect(await fetchContent(undefined)).toMatchObject({ status: 400 });
    expect(await fetchContent("")).toMatchObject({ status: 400 });
  });

  it("404s for a chat that does not exist", async () => {
    expect(await fetchContent("compact", { id: "no-such-chat" })).toMatchObject({ status: 404 });
  });

  /**
   * A per-directory plugin is switched on per browser, and an inactive one
   * contributes nothing to the autocomplete — so a chip's popover shows the
   * same set the composer offered, rather than a wider one.
   *
   * To be clear about what this is NOT: `activePlugins` is a query parameter,
   * so any caller can name any plugin and get its body back. This mirrors
   * client-side visibility; it withholds nothing from anyone, and nothing may
   * be built on top of it as though it did. The check that actually holds is
   * the one in readCommandFile, exercised further down.
   */
  it("keeps an inactive per-directory plugin out of the answer, as the listing does", async () => {
    const { status, body } = await fetchContent("proj:build", { activePlugins: [] });
    expect(status).toBe(200);
    expect(body).toEqual({ name: "proj:build", source: "builtin", description: null, content: null });

    // Naming a *different* plugin doesn't pull this one in either.
    expect((await fetchContent("proj:build", { activePlugins: ["link"] })).body.content).toBeNull();
  });
});

/**
 * The new-chat composer has no chat id — the folder is all it has, and picking
 * a skill there is the most common way a chip ever gets made.
 */
describe("GET /api/chats/new/slash-commands/content", () => {
  it("resolves a custom skill without any chat existing", async () => {
    const { status, body } = await fetchContentByFolder("callboard:my-skill");
    expect(status).toBe(200);
    expect(body).toEqual({ name: "callboard:my-skill", source: "custom-skill", description: "A skill of mine", content: SKILL_BODY });
  });

  it("resolves a plugin command against the folder it was handed", async () => {
    const { status, body } = await fetchContentByFolder("proj:build");
    expect(status).toBe(200);
    expect(body).toMatchObject({ source: "plugin", content: PLUGIN_BODY });
  });

  it("honours the same active-plugin filter as the per-chat route", async () => {
    expect((await fetchContentByFolder("proj:build", { activePlugins: [] })).body).toMatchObject({ source: "builtin", content: null });
  });

  it("applies the same name gate — a second door is not a weaker one", async () => {
    for (const name of ["proj:../secret", "../../etc/passwd", "proj:pw", "proj:leak"]) {
      const { status, body } = await fetchContentByFolder(name);
      if (status === 400) continue; // path-shaped names are refused outright
      expect(body).toMatchObject({ source: "builtin", content: null });
      expect(JSON.stringify(body)).not.toContain("TOPSECRET");
      expect(JSON.stringify(body)).not.toContain("root:x:0:0");
    }
    expect(await fetchContentByFolder("proj:../secret")).toMatchObject({ status: 400 });
    expect(await fetchContentByFolder("../../etc/passwd")).toMatchObject({ status: 400 });
  });

  it("requires a folder that exists, and a name", async () => {
    expect(await fetchContentByFolder("compact", { folder: "" })).toMatchObject({ status: 400 });
    expect(await fetchContentByFolder("compact", { folder: join(tmpdir(), "callboard-cmd-nope") })).toMatchObject({ status: 400 });
    expect(await fetchContentByFolder(undefined)).toMatchObject({ status: 400 });
  });
});

/**
 * The route's name check is the first fence; this is the second, and it is the
 * one that still holds if a future caller reaches the reader without going
 * through the route.
 */
describe("readCommandFile", () => {
  const COMMANDS_DIR = join(PROJECT_DIR, "plugins", "proj", "commands");

  it("reads a command that lives in the directory", () => {
    expect(readCommandFile(COMMANDS_DIR, "build")).toBe(PLUGIN_BODY);
  });

  it("refuses to leave the commands directory", () => {
    for (const name of ["../secret", "..\\secret", "../../../../etc/passwd", "/etc/passwd", "", "build\0"]) {
      expect(readCommandFile(COMMANDS_DIR, name)).toBeNull();
    }
  });

  /**
   * The name gate is lexical and a symlink is not: `commands/pw.md` is a
   * perfectly well-formed command name whose *target* is anywhere at all. Only
   * a real-path comparison can tell the difference.
   */
  it("refuses a symlink whose target is outside the commands directory", () => {
    expect(readCommandFile(COMMANDS_DIR, "pw")).toBeNull();
    expect(readCommandFile(COMMANDS_DIR, "leak")).toBeNull();
    expect(readCommandFile(COMMANDS_DIR, "relleak")).toBeNull();
  });

  it("still reads a symlink that stays inside the commands directory", () => {
    expect(readCommandFile(COMMANDS_DIR, "alias")).toBe(PLUGIN_BODY);
  });

  it("still reads through a symlinked commands directory", () => {
    // Both sides are real-pathed, so a symlinked plugin dir is not an escape.
    expect(readCommandFile(join(PROJECT_DIR, "plugins", "linked", "commands"), "build")).toBe(PLUGIN_BODY);
  });

  it("returns null for a command that simply isn't there", () => {
    expect(readCommandFile(COMMANDS_DIR, "nosuch")).toBeNull();
    expect(readCommandFile(join(PROJECT_DIR, "plugins", "nosuch", "commands"), "build")).toBeNull();
  });
});
