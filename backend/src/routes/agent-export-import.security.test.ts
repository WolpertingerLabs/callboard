/**
 * POST /api/agents/import against hostile archives, over a real socket with
 * the real agent/workspace file services rooted in a temp data dir.
 *
 * The pass condition is never just a status code: a refused import must also
 * leave no agent behind and no byte outside the workspace.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import AdmZip from "adm-zip";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listenRaw, type RawServer } from "./__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-import-sec-"));
process.env.CALLBOARD_DATA_DIR = DATA;
const OUTSIDE = mkdtempSync(join(tmpdir(), "callboard-import-sec-outside-"));

vi.mock("../services/cron-scheduler.js", () => ({ scheduleJob: vi.fn() }));
vi.mock("../services/reasoning-capabilities.js", () => ({ assertStoredReasoningEffort: vi.fn(async () => {}) }));

const { agentExportImportRouter, readEntryData } = await import("./agent-export-import.js");
const { WORKSPACES_DIR } = await import("../utils/paths.js");

let server: RawServer;

beforeAll(async () => {
  const app = express();
  app.use("/api/agents", agentExportImportRouter);
  server = await listenRaw(app);
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

async function upload(zip: Buffer): Promise<{ status: number; body: { error?: string } }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), "agent.zip");
  const res = await fetch(`${server.origin}/api/agents/import`, { method: "POST", body: form });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { error?: string } };
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
    expect(mode & 0o022).toBe(0); // 0o644 minus umask — never group/world-writable
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

  async function expectUntouched(zip: Buffer, status = 400): Promise<void> {
    const before = snapshot(ws());
    const res = await upload(zip);
    expect(res.status).toBe(status);
    expect(snapshot(ws())).toEqual(before);
    expect(outsideFiles()).toEqual([]);
    expect(agentCreated("partial")).toBe(false);
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

  it.skipIf(process.getuid?.() === 0)("a write that fails after validation is rolled back", async () => {
    seedWorkspace();
    writeFileSync(join(ws(), "Z.md"), "read-only");
    chmodSync(join(ws(), "Z.md"), 0o444);
    try {
      await expectUntouched(partialZip({ "workspace/Z.md": "z" }), 500);
    } finally {
      chmodSync(join(ws(), "Z.md"), 0o644);
    }
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
