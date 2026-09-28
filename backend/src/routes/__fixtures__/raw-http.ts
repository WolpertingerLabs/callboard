/**
 * A real listening socket plus a raw HTTP client that sends the request path
 * exactly as given — no URL parsing, no `..` normalization. Framework test
 * clients (and `fetch`/`new URL`) normalize `/a/../b` before the server ever
 * sees it, which is precisely the input a traversal test needs to deliver.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface RawServer {
  origin: string;
  request(method: string, path: string, body?: string | Buffer, headers?: Record<string, string>): Promise<RawResponse>;
  close(): Promise<void>;
}

export async function listenRaw(app: Express): Promise<RawServer> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    request(method, path, body, headers = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            method,
            path,
            headers: { ...(body !== undefined ? { "Content-Length": String(Buffer.byteLength(body)) } : {}), ...headers },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
