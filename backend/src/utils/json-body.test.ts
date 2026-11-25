import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { jsonBody } from "./json-body.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(jsonBody());
  app.post("/echo", (req, res) => {
    res.json({ body: req.body, type: typeof req.body });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("jsonBody", () => {
  it("gives a request with no body an empty object, as Express 4 did", async () => {
    const res = await fetch(`${base}/echo`, { method: "POST" });
    expect(await res.json()).toEqual({ body: {}, type: "object" });
  });

  it("gives a non-JSON request an empty object", async () => {
    const res = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" });
    expect(await res.json()).toEqual({ body: {}, type: "object" });
  });

  it("parses a JSON body", async () => {
    const res = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    expect(await res.json()).toEqual({ body: { a: 1 }, type: "object" });
  });
});
