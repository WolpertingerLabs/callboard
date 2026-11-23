/**
 * `/api/files/serve?path=…&download=1`, over a real socket.
 *
 * Any regular file may be downloaded, so the security contract is that its
 * bytes are never typed from the file: always `application/octet-stream` +
 * `attachment`, with `nosniff`, the sandbox CSP and PR1's
 * `Cache-Control: private, no-cache`, on every status.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenRaw, type RawResponse, type RawServer } from "./__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-files-download-http-"));
process.env.CALLBOARD_DATA_DIR = DATA;

const { filesRouter, attachmentDisposition } = await import("./files.js");

const SANDBOX_CSP = "default-src 'none'; sandbox";

let app: RawServer;

beforeAll(async () => {
  const prod = express();
  prod.use("/api/files", filesRouter);
  app = await listenRaw(prod);
});

afterAll(async () => {
  await app.close();
});

const download = (file: string, headers: Record<string, string> = {}, method = "GET") =>
  app.request(method, `/api/files/serve?path=${encodeURIComponent(file)}&download=1`, undefined, headers);

function expectDownload(res: RawResponse) {
  expect(res.headers["content-type"]).toBe("application/octet-stream");
  expect(res.headers["content-disposition"]).toMatch(/^attachment; /);
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(res.headers["content-security-policy"]).toBe(SANDBOX_CSP);
  expect(res.headers["cache-control"]).toBe("private, no-cache");
}

function file(name: string, content: string | Buffer = "x"): string {
  const p = join(DATA, name);
  writeFileSync(p, content);
  return p;
}

describe("download=1", () => {
  it.each([
    ["page.html", "<script>alert(1)</script>"],
    ["pic.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ["archive.zip", "PK\u0003\u0004"],
    ["clip.mp4", "not really"],
  ])("%s is served as an octet-stream attachment, with nosniff and the CSP", async (name, content) => {
    const res = await download(file(name, content));
    expect(res.status).toBe(200);
    expectDownload(res);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="${name}"; filename*=UTF-8''${name}`);
    expect(res.body.toString()).toBe(content);
  });

  it("Range on a download → 206, still an attachment", async () => {
    const p = file("blob.bin", Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
    const res = await download(p, { Range: "bytes=10-19" });
    expect(res.status).toBe(206);
    expectDownload(res);
    expect(res.headers["content-range"]).toBe("bytes 10-19/1000");
    expect([...res.body]).toEqual(Array.from({ length: 10 }, (_, i) => i + 10));
  });

  it("HEAD and 416 keep the download headers", async () => {
    const p = file("small.dat", "0123456789");
    const head = await download(p, {}, "HEAD");
    expect(head.status).toBe(200);
    expectDownload(head);
    expect(head.body.length).toBe(0);
    const unsatisfiable = await download(p, { Range: "bytes=50-" });
    expect(unsatisfiable.status).toBe(416);
    expectDownload(unsatisfiable);
  });

  it("a filename with quotes, CR/LF, a backslash and non-ASCII yields a well-formed Content-Disposition", async () => {
    // CR/LF can't be in a header, so this is what most needs sanitising.
    const name = 'we"ird\r\nna\\me – ünï.txt';
    const res = await download(file(name, "hi"));
    expect(res.status).toBe(200);
    expectDownload(res);
    const cd = res.headers["content-disposition"]!;
    expect(cd).toBe(`attachment; filename="weirdname _ _n_.txt"; filename*=UTF-8''${encodeURIComponent(name)}`);
    expect(cd).not.toMatch(/[\r\n]/);
    const star = /filename\*=UTF-8''(.*)$/.exec(cd)![1];
    expect(decodeURIComponent(star)).toBe(name);
  });

  it("attachmentDisposition encodes RFC 5987 non-attr-chars and never yields an empty fallback", () => {
    expect(attachmentDisposition("it's (1)*!.txt")).toBe(`attachment; filename="it's (1)*!.txt"; filename*=UTF-8''it%27s%20%281%29%2A%21.txt`);
    expect(attachmentDisposition('"\r\n"')).toBe(`attachment; filename="download"; filename*=UTF-8''%22%0D%0A%22`);
  });

  it("download=1 with url= → 400, and nothing is fetched", async () => {
    const res = await app.request("GET", `/api/files/serve?url=${encodeURIComponent("https://example.com/a.zip")}&download=1`);
    expect(res.status).toBe(400);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe(SANDBOX_CSP);
  });

  // Root reads a mode-000 file regardless, so there is no read error to provoke.
  it.skipIf(process.getuid?.() === 0)("a late read error is a JSON error without the attachment headers", async () => {
    const p = file("locked.bin", "secret");
    chmodSync(p, 0o000);
    try {
      const res = await download(p);
      expect(res.status).toBe(500);
      expect(res.headers["content-type"]).toMatch(/^application\/json/);
      expect(res.headers["content-disposition"]).toBeUndefined();
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBe(SANDBOX_CSP);
      expect(JSON.parse(res.body.toString())).toEqual({ error: "Failed to read file" });
    } finally {
      chmodSync(p, 0o644);
    }
  });

  it("a directory → 400, a missing path → 404, a relative path → 400", async () => {
    const dir = join(DATA, "a-dir");
    mkdirSync(dir, { recursive: true });
    expect((await download(dir)).status).toBe(400);
    expect((await download(join(DATA, "nope.zip"))).status).toBe(404);
    expect((await download("relative/x.zip")).status).toBe(400);
  });

  it("without download=1 an unknown type is still 415", async () => {
    const res = await app.request("GET", `/api/files/serve?path=${encodeURIComponent(file("other.zip"))}`);
    expect(res.status).toBe(415);
  });
});
