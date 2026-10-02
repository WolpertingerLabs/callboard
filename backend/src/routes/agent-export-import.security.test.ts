/**
 * POST /api/agents/import against hostile archives, over a real socket with
 * the real agent/workspace file services rooted in a temp data dir.
 *
 * The pass condition is never just a status code: a refused import must also
 * leave no agent behind and no byte outside the workspace.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import AdmZip from "adm-zip";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listenRaw, type RawServer } from "./__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-import-sec-"));
process.env.CALLBOARD_DATA_DIR = DATA;
const OUTSIDE = mkdtempSync(join(tmpdir(), "callboard-import-sec-outside-"));

vi.mock("../services/cron-scheduler.js", () => ({ scheduleJob: vi.fn() }));
vi.mock("../services/reasoning-capabilities.js", () => ({ assertStoredReasoningEffort: vi.fn(async () => {}) }));
// createAgent is the real one unless a test sets a failure for it.
const fileService = vi.hoisted(() => ({ createAgentFailure: null as Error | null }));
vi.mock("../services/agent-file-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-file-service.js")>();
  return {
    ...actual,
    createAgent: (config: Parameters<typeof actual.createAgent>[0]) => {
      if (fileService.createAgentFailure) throw fileService.createAgentFailure;
      return actual.createAgent(config);
    },
  };
});

const { agentExportImportRouter, readEntryData, workspaceFs } = await import("./agent-export-import.js");
const { WORKSPACES_DIR } = await import("../utils/paths.js");

let server: RawServer;

beforeAll(async () => {
  const app = express();
  app.use("/api/agents", agentExportImportRouter);
  server = await listenRaw(app);
});

afterEach(() => {
  vi.restoreAllMocks();
  fileService.createAgentFailure = null;
});

afterAll(async () => {
  await server.close();
  rmSync(DATA, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(DATA, "agents"), { recursive: true, force: true });
  rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
  mkdirSync(OUTSIDE, { recursive: true });
});

const agentJson = (alias = "probe") => Buffer.from(JSON.stringify({ name: "Probe", alias, description: "d" }));

function baseZip(alias = "probe"): AdmZip {
  const zip = new AdmZip();
  zip.addFile("agent.json", agentJson(alias));
  return zip;
}

/** Same-length rename of every occurrence of `from` in the raw archive (local + central headers). */
function rename(raw: Buffer, from: string, to: string): Buffer {
  expect(to.length).toBe(from.length);
  const out = Buffer.from(raw);
  for (let at = out.indexOf(from); at >= 0; at = out.indexOf(from, at + from.length)) out.write(to, at);
  return out;
}

/** Overwrite the declared uncompressed size of `name` in both local and central headers. */
function setDeclaredSize(raw: Buffer, name: string, size: number): Buffer {
  const out = Buffer.from(raw);
  for (let at = 0; at < out.length - 4; at++) {
    const sig = out.readUInt32LE(at);
    if (sig === 0x04034b50 && out.toString("utf8", at + 30, at + 30 + out.readUInt16LE(at + 26)) === name) out.writeUInt32LE(size, at + 22);
    if (sig === 0x02014b50 && out.toString("utf8", at + 46, at + 46 + out.readUInt16LE(at + 28)) === name) out.writeUInt32LE(size, at + 24);
  }
  return out;
}

type ImportBody = { error?: string; rollbackFailures?: { path: string; backup?: string; error: string }[] };

async function upload(zip: Buffer): Promise<{ status: number; body: ImportBody }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), "agent.zip");
  const res = await fetch(`${server.origin}/api/agents/import`, { method: "POST", body: form });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as ImportBody };
}

const agentCreated = (alias = "probe") => existsSync(join(DATA, "agents", alias, "agent.json"));
const outsideFiles = () => readdirSync(OUTSIDE, { recursive: true });

describe("agent import: hostile archives", () => {
  it("imports a well-formed archive with fixed, non-setuid file modes", async () => {
    const zip = baseZip();
    zip.addFile("workspace/SOUL.md", Buffer.from("soul"));
    zip.addFile("workspace/memory/note.md", Buffer.from("note"));
    const res = await upload(zip.toBuffer());
    expect(res.status).toBe(201);
    expect(readFileSync(join(WORKSPACES_DIR, "probe", "SOUL.md"), "utf8")).toBe("soul");
    expect(readFileSync(join(WORKSPACES_DIR, "probe", "memory", "note.md"), "utf8")).toBe("note");
    expect(agentCreated()).toBe(true);
  });

  it("refuses a symbolic-link entry", async () => {
    const zip = baseZip();
    zip.addFile("workspace/link.md", Buffer.from("/etc/passwd")).attr = ((0o120777 << 16) | 0) >>> 0;
    const res = await upload(zip.toBuffer());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/symbolic link/);
    expect(agentCreated()).toBe(false);
    expect(existsSync(join(WORKSPACES_DIR, "probe"))).toBe(false);
  });

  it("never applies setuid/setgid bits from the archive", async () => {
    const zip = baseZip();
    zip.addFile("workspace/SOUL.md", Buffer.from("x")).attr = ((0o106777 << 16) | 0) >>> 0;
    expect((await upload(zip.toBuffer())).status).toBe(201);
    const mode = statSync(join(WORKSPACES_DIR, "probe", "SOUL.md")).mode;
    expect(mode & 0o7000).toBe(0);
  });

  /** The mode writeFileSync gives a new file under this process's umask. */
  function writeFileSyncMode(): number {
    const probe = join(OUTSIDE, "umask-probe");
    writeFileSync(probe, "");
    const mode = statSync(probe).mode & 0o777;
    rmSync(probe);
    return mode;
  }

  it("creates new files with writeFileSync's mode, so the process umask applies", async () => {
    const previous = process.umask(0o077);
    try {
      expect(writeFileSyncMode()).toBe(0o600);
      const zip = baseZip();
      zip.addFile("workspace/SOUL.md", Buffer.from("x"));
      expect((await upload(zip.toBuffer())).status).toBe(201);
      expect(statSync(join(WORKSPACES_DIR, "probe", "SOUL.md")).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it("a replaced file keeps its own mode, not the umask's", async () => {
    const ws = join(WORKSPACES_DIR, "probe");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "SOUL.md"), "old");
    chmodSync(join(ws, "SOUL.md"), 0o640);
    const zip = baseZip();
    zip.addFile("workspace/SOUL.md", Buffer.from("new"));
    expect((await upload(zip.toBuffer())).status).toBe(201);
    expect(readFileSync(join(ws, "SOUL.md"), "utf8")).toBe("new");
    expect(statSync(join(ws, "SOUL.md")).mode & 0o7777).toBe(0o640);
  });

  it.each([
    ["workspace/aaaa.md", "workspace/../x.md"],
    ["aaaaaaaaaaaaaaaa.md", "../../../../../x.md"],
    ["aaaaaaaaaaaaaaaa.md", "/tmp/callboard-x.md"],
    ["workspace/aaaaaaaaaaaaaa.md", "workspace/memory/../../x.md"],
  ])("refuses a traversal entry name (%s → %s)", async (placeholder, hostile) => {
    const zip = baseZip();
    zip.addFile(placeholder, Buffer.from("PWNED"));
    const res = await upload(rename(zip.toBuffer(), placeholder, hostile));
    expect(res.status).toBe(400);
    expect(agentCreated()).toBe(false);
    expect(existsSync(join(WORKSPACES_DIR, "x.md"))).toBe(false);
    expect(existsSync(join(DATA, "x.md"))).toBe(false);
  });

  it("refuses to write through a symlinked directory planted in a pre-existing workspace", async () => {
    mkdirSync(join(WORKSPACES_DIR, "probe"), { recursive: true });
    symlinkSync(OUTSIDE, join(WORKSPACES_DIR, "probe", "memory"));
    const zip = baseZip();
    zip.addFile("workspace/memory/authorized_keys.md", Buffer.from("PWNED"));
    const res = await upload(zip.toBuffer());
    expect(res.status).toBe(400);
    expect(outsideFiles()).toEqual([]);
    expect(agentCreated()).toBe(false);
  });

  it("refuses to write through a symlinked file planted in a pre-existing workspace", async () => {
    const victim = join(OUTSIDE, "victim");
    writeFileSync(victim, "original");
    mkdirSync(join(WORKSPACES_DIR, "probe"), { recursive: true });
    symlinkSync(victim, join(WORKSPACES_DIR, "probe", "SOUL.md"));
    const zip = baseZip();
    zip.addFile("workspace/SOUL.md", Buffer.from("PWNED"));
    const res = await upload(zip.toBuffer());
    expect(res.status).toBe(400);
    expect(readFileSync(victim, "utf8")).toBe("original");
    expect(agentCreated()).toBe(false);
  });

  it("refuses duplicate entry names (getEntry and iteration would disagree)", async () => {
    const zip = baseZip();
    zip.addFile("agent.jsoX", agentJson("other"));
    const res = await upload(rename(zip.toBuffer(), "agent.jsoX", "agent.json"));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/duplicate/);
    expect(agentCreated("probe") || agentCreated("other")).toBe(false);
  });

  it("refuses an entry declaring a huge size from a few bytes (GHSA-7q85 PoC)", async () => {
    const poc = Buffer.from(
      "UEsDBBQAAAAAAAAAAAAAAAAABQAAAAUAAAABAAAAYWhlbGxvUEsBAhQAFAAAAAAAAAAAAAAAAAAFAAAA4C7DaQEAAAAAAAAAAAAAAAAAAAAAAGFQSwUGAAAAAAEAAQAvAAAAJAAAAAAA",
      "base64",
    );
    const res = await upload(poc);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/compression ratio/);
  });

  it("does not inflate an entry that declares size 0 (GHSA-rcw4 cap bypass)", async () => {
    const bomb = Buffer.alloc(8 * 1024 * 1024, 0x41); // ~8KB deflated
    const zip = baseZip();
    zip.addFile("workspace/BOMB.md", bomb);
    const raw = setDeclaredSize(zip.toBuffer(), "workspace/BOMB.md", 0);

    const entry = new AdmZip(raw).getEntry("workspace/BOMB.md")!;
    expect(entry.header.size).toBe(0);
    expect(entry.header.compressedSize).toBeGreaterThan(0);
    const getData = vi.spyOn(entry, "getData");
    expect(readEntryData(entry).length).toBe(0);
    expect(getData).not.toHaveBeenCalled();

    const res = await upload(raw);
    expect(res.status).toBe(201);
    expect(statSync(join(WORKSPACES_DIR, "probe", "BOMB.md")).size).toBe(0);
  });

  it("rejects a corrupt entry before creating anything", async () => {
    const zip = baseZip();
    zip.addFile("workspace/SOUL.md", Buffer.from("soul soul soul soul"));
    const raw = zip.toBuffer();
    // Flip one byte of SOUL.md's compressed data: CRC no longer matches.
    const entry = new AdmZip(raw).getEntry("workspace/SOUL.md")!;
    const dataStart = raw.indexOf(Buffer.from("workspace/SOUL.md")) + "workspace/SOUL.md".length;
    raw[dataStart + entry.header.compressedSize - 1] ^= 0xff;
    const res = await upload(raw);
    expect(res.status).toBe(400);
    expect(agentCreated()).toBe(false);
  });
});

describe("agent import: replacing a hard-linked file", () => {
  it("replaces the workspace entry and never writes through a link to a file outside", async () => {
    const victim = join(OUTSIDE, "victim");
    writeFileSync(victim, "original");
    const ws = join(WORKSPACES_DIR, "probe");
    mkdirSync(ws, { recursive: true });
    linkSync(victim, join(ws, "SOUL.md"));
    const zip = baseZip();
    zip.addFile("workspace/SOUL.md", Buffer.from("PWNED"));
    const res = await upload(zip.toBuffer());
    expect(res.status).toBe(201);
    expect(readFileSync(victim, "utf8")).toBe("original");
    expect(readFileSync(join(ws, "SOUL.md"), "utf8")).toBe("PWNED");
    expect(readdirSync(ws).filter((n) => n.includes(".import-"))).toEqual([]);
  });
});

describe("agent import: a refused import leaves the workspace byte-identical", () => {
  const ws = () => join(WORKSPACES_DIR, "partial");

  /** Every entry under `dir`: type, mode, bytes or link target — lstat, so links are never followed. */
  function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
      const p = join(dir, rel);
      const st = lstatSync(p);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) out[rel] = `link ${readlinkSync(p)}`;
      else if (st.isDirectory()) out[rel] = `dir ${mode}`;
      else out[rel] = `file ${mode} ${readFileSync(p).toString("base64")}`;
    }
    return out;
  }

  function seedWorkspace(): void {
    mkdirSync(ws(), { recursive: true });
    writeFileSync(join(ws(), "SOUL.md"), "preexisting soul");
  }

  function partialZip(extra: Record<string, string>): Buffer {
    const zip = baseZip("partial");
    zip.addFile("workspace/A.md", Buffer.from("A from zip"));
    zip.addFile("workspace/SOUL.md", Buffer.from("SOUL from zip"));
    for (const [name, body] of Object.entries(extra)) zip.addFile(name, Buffer.from(body));
    return zip.toBuffer();
  }

  async function expectUntouched(zip: Buffer, status = 400): Promise<ImportBody> {
    const before = snapshot(ws());
    const res = await upload(zip);
    expect(res.status).toBe(status);
    expect(snapshot(ws())).toEqual(before);
    expect(outsideFiles()).toEqual([]);
    expect(agentCreated("partial")).toBe(false);
    return res.body;
  }

  it("a planted memory -> outside symlink (the review's repro)", async () => {
    seedWorkspace();
    symlinkSync(OUTSIDE, join(ws(), "memory"));
    await expectUntouched(partialZip({ "workspace/memory/x.md": "PWNED" }));
  });

  it("a file where the archive needs a directory", async () => {
    seedWorkspace();
    writeFileSync(join(ws(), "memory"), "i am a file");
    await expectUntouched(partialZip({ "workspace/memory/x.md": "x" }));
  });

  it("a directory where the archive needs a file", async () => {
    seedWorkspace();
    mkdirSync(join(ws(), "B.md"));
    await expectUntouched(partialZip({ "workspace/B.md": "b" }));
  });

  type FsOp = keyof typeof workspaceFs;
  type AnyFn = (...args: unknown[]) => unknown;

  /** Wrap one workspaceFs op around whatever it currently does — stacking, never re-spying a spy onto itself. */
  function wrapFs(op: FsOp, wrapper: (inner: AnyFn, args: unknown[]) => unknown): void {
    const current = workspaceFs[op] as unknown as AnyFn & { getMockImplementation?: () => AnyFn | undefined };
    const inner: AnyFn = vi.isMockFunction(current) ? current.getMockImplementation()! : current;
    vi.spyOn(workspaceFs, op).mockImplementation(((...args: unknown[]) => wrapper(inner, args)) as never);
  }

  /** Make `op` throw when it touches a file whose name starts with `name` (and `when` agrees). */
  function failOn(name: string, op: FsOp, when: (paths: string[]) => boolean = () => true, code = "EIO"): void {
    wrapFs(op, (inner, args) => {
      const paths = args.filter((a): a is string => typeof a === "string");
      if (paths.some((p) => basename(p).replace(/^\./, "").toLowerCase().startsWith(name.toLowerCase())) && when(paths)) {
        throw Object.assign(new Error(`injected ${op} failure`), { code });
      }
      return inner(...args);
    });
  }

  it("a write that fails after validation is rolled back", async () => {
    seedWorkspace();
    failOn("zz.md", "openSync");
    const before = snapshot(ws());
    const res = await upload(partialZip({ "workspace/zz.md": "z" }));
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/injected \w+ failure.*nothing was changed/);
    expect(res.body.rollbackFailures).toBeUndefined();
    expect(snapshot(ws())).toEqual(before);
    expect(agentCreated("partial")).toBe(false);
  });

  it("a failure before anything changed reports nothing changed and restores nothing", async () => {
    seedWorkspace();
    // The first rename of SOUL.md is the move to its backup; it never happens.
    failOn("SOUL.md", "renameSync", ([from]) => basename(from) === "SOUL.md");
    const before = snapshot(ws());
    const res = await upload(partialZip({}));
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/injected \w+ failure.*nothing was changed/);
    expect(res.body.rollbackFailures).toBeUndefined();
    expect(snapshot(ws())).toEqual(before);
  });

  it("a restore that fails keeps the original on disk and says where", async () => {
    seedWorkspace();
    writeFileSync(join(ws(), "SOUL.md"), "precious original");
    failOn("zz.md", "openSync");
    failOn("SOUL.md", "renameSync", ([from]) => basename(from).includes(".import-backup-"));
    const res = await upload(partialZip({ "workspace/zz.md": "z" }));
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/injected openSync failure/);
    expect(res.body.error).not.toMatch(/nothing was changed/);
    expect(res.body.error).toMatch(/SOUL\.md/);
    expect(res.body.rollbackFailures).toEqual([{ path: "SOUL.md", backup: expect.stringMatching(/^\.SOUL\.md\.import-backup-/), error: expect.any(String) }]);
    const backup = res.body.rollbackFailures![0].backup!;
    expect(readFileSync(join(ws(), backup), "utf8")).toBe("precious original");
    expect(agentCreated("partial")).toBe(false);
  });

  it("a memory/ directory the import created is removed on rollback", async () => {
    seedWorkspace();
    failOn("zz.md", "openSync");
    const body = await expectUntouched(partialZip({ "workspace/memory/new.md": "m", "workspace/zz.md": "z" }), 500);
    expect(body.error).toMatch(/injected openSync failure.*nothing was changed/);
    expect(existsSync(join(ws(), "memory"))).toBe(false);
  });

  it("a failed temp->target rename puts the original back", async () => {
    seedWorkspace();
    writeFileSync(join(ws(), "SOUL.md"), "precious original");
    failOn("SOUL.md", "renameSync", ([from]) => basename(from).includes(".import-tmp-"));
    const before = snapshot(ws());
    const res = await upload(partialZip({}));
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/injected renameSync failure.*nothing was changed/);
    expect(snapshot(ws())).toEqual(before);
  });

  it("where link() is unsupported (EPERM), new files are created directly and the import succeeds", async () => {
    seedWorkspace();
    failOn("", "linkSync", () => true, "EPERM");
    const res = await upload(partialZip({ "workspace/memory/m.md": "m" }));
    expect(res.status).toBe(201);
    expect(readFileSync(join(ws(), "A.md"), "utf8")).toBe("A from zip");
    expect(readFileSync(join(ws(), "SOUL.md"), "utf8")).toBe("SOUL from zip");
    expect(readFileSync(join(ws(), "memory", "m.md"), "utf8")).toBe("m");
    expect((readdirSync(ws(), { recursive: true }) as string[]).filter((n) => n.includes(".import-"))).toEqual([]);
    expect(agentCreated("partial")).toBe(true);
  });

  it("a pre-existing agent dir survives a createAgent failure", async () => {
    seedWorkspace();
    mkdirSync(join(DATA, "agents", "partial"), { recursive: true });
    writeFileSync(join(DATA, "agents", "partial", "keep.txt"), "keep");
    fileService.createAgentFailure = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    expect((await upload(partialZip({}))).status).toBe(500);
    expect(readFileSync(join(DATA, "agents", "partial", "keep.txt"), "utf8")).toBe("keep");
  });

  it("a createAgent failure still rolls back and answers when removing the agent dir also fails", async () => {
    seedWorkspace();
    fileService.createAgentFailure = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    failOn("partial", "rmSync");
    const body = await expectUntouched(partialZip({ "workspace/memory/new.md": "m" }), 500);
    expect(body.error).toMatch(/ENOSPC.*nothing was changed/);
  });

  it("a createAgent failure after the workspace writes rolls them back", async () => {
    seedWorkspace();
    fileService.createAgentFailure = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const body = await expectUntouched(partialZip({ "workspace/memory/new.md": "m" }), 500);
    expect(body.error).toMatch(/ENOSPC.*nothing was changed/);
    expect(existsSync(join(DATA, "agents", "partial"))).toBe(false);
  });

  it("rolls back in reverse order (two names for one file, as on a case-insensitive filesystem)", async () => {
    // Every workspaceFs call sees file names lowercased: SOUL.md and soul.md are one directory entry.
    const lower = (p: unknown) => (typeof p === "string" ? join(dirname(p), basename(p).toLowerCase()) : p);
    for (const op of Object.keys(workspaceFs) as FsOp[]) wrapFs(op, (inner, args) => inner(...args.map(lower)));
    mkdirSync(ws(), { recursive: true });
    writeFileSync(join(ws(), "soul.md"), "original");
    failOn("zz.md", "openSync");
    const zip = baseZip("partial");
    zip.addFile("workspace/SOUL.md", Buffer.from("upper"));
    zip.addFile("workspace/soul.md", Buffer.from("lower"));
    zip.addFile("workspace/zz.md", Buffer.from("z"));
    const before = snapshot(ws());
    const res = await upload(zip.toBuffer());
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/injected openSync failure/); // reached zz.md, i.e. both replacements happened
    expect(readFileSync(join(ws(), "soul.md"), "utf8")).toBe("original");
    expect(snapshot(ws())).toEqual(before);
  });
});

describe("multipart uploads with hostile field names", () => {
  // A regression here freezes the event loop, which would hang the whole test
  // worker — so the real routers are driven from a child with a hard timeout.
  it("every upload route answers promptly and the process survives", () => {
    const backendDir = fileURLToPath(new URL("../..", import.meta.url));
    const routes = fileURLToPath(new URL(".", import.meta.url));
    const childData = mkdtempSync(join(tmpdir(), "callboard-multer-sec-"));
    const script = `
      process.env.CALLBOARD_DATA_DIR = ${JSON.stringify(childData)};
      const { default: express } = await import("express");
      const { imagesRouter } = await import(${JSON.stringify(join(routes, "images.ts"))});
      const { storageRouter } = await import(${JSON.stringify(join(routes, "storage.ts"))});
      const { agentExportImportRouter } = await import(${JSON.stringify(join(routes, "agent-export-import.ts"))});
      const app = express();
      app.use("/api/chats", imagesRouter);
      app.use("/api/storage", storageRouter);
      app.use("/api/agents", agentExportImportRouter);
      process.on("uncaughtException", (e) => { console.log(JSON.stringify({ crash: e.message })); process.exit(3); });
      const srv = app.listen(0, "127.0.0.1", async () => {
        const base = "http://127.0.0.1:" + srv.address().port;
        const targets = [
          ["POST", "/api/chats/c1/images", "images"],
          ["PUT", "/api/storage/k/items/x.txt", "file"],
          ["POST", "/api/agents/import", "file"],
        ];
        const attacks = [
          ["items[4294967294]", "items[x]"],   // GHSA-535w: sparse-array walk, freezes the loop
          ["items[4294967294]", "items[]"],    // GHSA-wc9g: uncaught RangeError, kills the process
          ["a".repeat(5000)],                  // oversized name
        ];
        const out = [];
        for (const [method, path, fileField] of targets) {
          for (const names of attacks) {
            const fd = new FormData();
            for (const n of names) fd.append(n, "v");
            fd.append(fileField, new Blob([Buffer.from("x")], { type: "image/png" }), "a.png");
            const t = Date.now();
            const res = await fetch(base + path, { method, body: fd });
            out.push({ path, names: names.join("+").slice(0, 40), status: res.status, ms: Date.now() - t });
          }
        }
        console.log(JSON.stringify(out));
        srv.close();
      });
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: backendDir,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NODE_ENV: "test" },
    });
    rmSync(childData, { recursive: true, force: true });

    expect(child.signal, `child hung (event loop frozen?)\n${child.stderr}`).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    const results = JSON.parse(child.stdout.trim().split("\n").pop()!) as { path: string; names: string; status: number; ms: number }[];
    expect(results).toHaveLength(9);
    for (const r of results) {
      expect(r.status, `${r.path} ${r.names}`).toBe(400);
      expect(r.ms, `${r.path} ${r.names}`).toBeLessThan(5_000);
    }
  }, 40_000);
});
