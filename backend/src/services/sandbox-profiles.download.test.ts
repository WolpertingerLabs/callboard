/**
 * Profile downloads against real local TLS servers: the host fetches recipe
 * URLs itself, so it must not be pointable at this machine or its network.
 * Every redirect hop is checked as a fresh URL (https, a public host name),
 * every name is resolved by Callboard and every address it resolves to must be
 * public, and the connection is pinned to the address that was checked.
 *
 * The servers listen on 127.0.0.1 with a throwaway self-signed certificate
 * (made with `openssl`; skipped without it). Names resolve through a test
 * resolver, and the test's address policy lets exactly one name
 * (`dl.test.example`) reach loopback, standing in for a public host: every
 * other name that resolves to 127.0.0.1 is what an attacker would aim at.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOWNLOAD_MAX_REDIRECTS, fetchVerified } from "./sandbox-profiles.js";

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const body = Buffer.from("profile download bytes\n");
const sha = createHash("sha256").update(body).digest("hex");
let dir = "";
let cert = "";
let tls: Server;
let tlsPort = 0;
/** A second, plain-HTTP server standing for something on this machine; it must never be reached. */
let inner: HttpServer;
let innerPort = 0;
let innerHits = 0;
const lookups: string[] = [];
const routes = new Map<string, (res: import("node:http").ServerResponse) => void>();

beforeAll(async () => {
  if (!hasOpenssl) return;
  dir = mkdtempSync(join(tmpdir(), "cb-profile-download-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=dl.test.example",
      "-addext",
      "subjectAltName=DNS:dl.test.example,DNS:evil.test.example",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(join(dir, "cert.pem"), "utf8");
  tls = createServer({ key: readFileSync(join(dir, "key.pem")), cert }, (req, res) => {
    const route = routes.get(req.url ?? "");
    if (route) route(res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
  tlsPort = (tls.address() as AddressInfo).port;
  inner = createHttpServer((_req, res) => {
    innerHits++;
    res.end("secret");
  });
  await new Promise<void>((resolve) => inner.listen(0, "127.0.0.1", resolve));
  innerPort = (inner.address() as AddressInfo).port;
  const redirect = (to: string) => (res: import("node:http").ServerResponse) => res.writeHead(302, { location: to }).end();
  routes.set("/file", (res) => res.end(body));
  routes.set("/to-file", redirect(`https://dl.test.example:${tlsPort}/file`));
  routes.set("/to-relative", redirect("/file"));
  routes.set("/to-http-loopback", redirect(`http://127.0.0.1:${innerPort}/`));
  routes.set("/to-https-ip", redirect(`https://127.0.0.1:${tlsPort}/file`));
  routes.set("/to-localhost", redirect(`https://localhost:${tlsPort}/file`));
  routes.set("/to-inward-name", redirect(`https://evil.test.example:${tlsPort}/file`));
  routes.set("/to-metadata", redirect("https://metadata.internal/latest"));
  routes.set("/loop", redirect(`https://dl.test.example:${tlsPort}/loop`));
  routes.set("/wrong", (res) => res.end("something else entirely"));
});

afterAll(async () => {
  if (!hasOpenssl) return;
  await new Promise((resolve) => tls.close(resolve));
  await new Promise((resolve) => inner.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

/** Every name resolves to loopback; only dl.test.example may connect there (the stand-in for a public host). */
const options = (dataDir: string) => ({
  dataDir,
  ca: cert,
  lookup: async (hostname: string) => {
    lookups.push(hostname);
    return [{ address: "127.0.0.1", family: 4 }];
  },
  addressAllowed: (_address: string, url: URL) => url.hostname === "dl.test.example",
});
const fresh = () => mkdtempSync(join(dir, "data-"));
const url = (path: string) => `https://dl.test.example:${tlsPort}${path}`;

describe.skipIf(!hasOpenssl)("profile downloads (local TLS servers)", () => {
  it("fetches, verifies and caches; follows redirects (absolute and relative) on allowed hosts, resolving each hop once", async () => {
    const data = fresh();
    lookups.length = 0;
    const file = await fetchVerified({ url: url("/to-file"), sha256: sha }, options(data));
    expect(readFileSync(file)).toEqual(body);
    expect(lookups).toEqual(["dl.test.example", "dl.test.example"]);
    // From the cache: no network at all.
    lookups.length = 0;
    expect(await fetchVerified({ url: url("/to-file"), sha256: sha }, options(data))).toBe(file);
    expect(lookups).toEqual([]);
    expect(readFileSync(await fetchVerified({ url: url("/to-relative"), sha256: sha }, options(fresh())))).toEqual(body);
  });

  it("re-checks every redirect hop: plain http, IP literals, localhost, .internal names and names resolving inward are refused, and nothing inward is ever reached", async () => {
    const cases: [string, RegExp][] = [
      ["/to-http-loopback", /redirected to a URL that must be https:\/\//],
      ["/to-https-ip", /redirected to a URL that must name a host, not an IP address/],
      ["/to-localhost", /redirected to a URL that must name a public host/],
      ["/to-metadata", /redirected to a URL that must name a public host/],
      ["/to-inward-name", /evil\.test\.example resolves to a loopback, private, link-local or reserved address/],
    ];
    for (const [path, message] of cases) await expect(fetchVerified({ url: url(path), sha256: sha }, options(fresh())), path).rejects.toThrow(message);
    expect(innerHits).toBe(0);
  });

  it("caps the redirects", async () => {
    await expect(fetchVerified({ url: url("/loop"), sha256: sha }, options(fresh()))).rejects.toThrow(`more than ${DOWNLOAD_MAX_REDIRECTS} redirects`);
  });

  it("with the default policy, a name resolving to loopback is refused before any connection", async () => {
    const { addressAllowed: _allowed, ...strict } = options(fresh());
    await expect(fetchVerified({ url: url("/file"), sha256: sha }, strict)).rejects.toThrow(/resolves to a loopback/);
  });

  it("a checksum mismatch says so without echoing the digest that arrived, and caches nothing", async () => {
    const data = fresh();
    const actual = createHash("sha256").update("something else entirely").digest("hex");
    const error = await fetchVerified({ url: url("/wrong"), sha256: sha }, options(data)).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/failed its checksum \(sha256 mismatch\)/);
    expect((error as Error).message).not.toContain(actual);
    expect(await readdir(join(data, "sandbox-desktop", "profile-downloads"))).toEqual([]);
  });

  it("pins the connection to the checked address: a resolver that changes its answer (rebinding) is asked once per hop", async () => {
    let calls = 0;
    const rebinding = {
      ...options(fresh()),
      lookup: async () => {
        calls++;
        // The first answer is checked and used; a later answer (an attacker's rebind) would be 10.0.0.1, but nothing asks again.
        return calls === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.1", family: 4 }];
      },
    };
    expect(readFileSync(await fetchVerified({ url: url("/file"), sha256: sha }, rebinding))).toEqual(body);
    expect(calls).toBe(1);
  });
});
