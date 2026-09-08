/**
 * A computer-control session that lands in `failed` used to leave nothing in
 * the server log: the route answers the browser with a deliberately sanitized
 * message and no one wrote the real cause down. These tests pin both halves —
 * the detail reaches the log, and the HTTP body stays as narrow as it was.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const logs = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ createLogger: () => logs, default: () => logs }));
// Partial: only the session check is stubbed. `controlOriginError` stays real,
// because these requests go through the router's own origin middleware — they
// send a matching `Origin` header for exactly that reason.
vi.mock("../auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth.js")>()),
  requireSessionAuth: (_req: Request, _res: Response, next: () => void) => next(),
}));
vi.mock("../services/computer-use.js", async (original) => ({
  ...(await original<typeof import("../services/computer-use.js")>()),
  getComputerUseHost: vi.fn(),
}));

import express from "express";
import type { Server } from "node:http";
import { getComputerUseHost } from "../services/computer-use.js";
import { computerUseRouter } from "./computer-use.js";

const SANITIZED = "Computer control is unavailable. Check the configured driver prerequisites.";
/** What the browser driver actually says when Chromium's sandbox cannot start. */
const SANDBOX =
  "Sandboxed Chromium launch failed. Provision a supported browser and its OS libraries; on Linux use a non-root user and permit Chromium's sandbox (user namespaces/seccomp or a supported sandbox helper). No unsandboxed fallback is permitted.";

let server: Server;
let origin: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/computer-use", computerUseRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  logs.error.mockClear();
  logs.warn.mockClear();
  logs.debug.mockClear();
});

const post = (path: string, body: unknown) =>
  fetch(`${origin}/api/computer-use/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
const errorLine = () => String(logs.error.mock.calls.at(0)?.[0] ?? "");

it("logs an uncoded driver launch failure in full while the client still gets only the sanitized message", async () => {
  const open = vi.fn().mockRejectedValue(new Error("spawn /opt/chromium/chrome-sandbox EACCES"));
  vi.mocked(getComputerUseHost).mockResolvedValue({ open } as never);

  const response = await post("chat-77/open", { kind: "browser" });

  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body).toEqual({ code: "unavailable", error: SANITIZED });
  expect(JSON.stringify(body)).not.toContain("chrome-sandbox");

  expect(logs.error).toHaveBeenCalledOnce();
  expect(errorLine()).toContain("open");
  expect(errorLine()).toContain("chat=chat-77");
  expect(errorLine()).toContain("code=unavailable");
  expect(errorLine()).toContain("spawn /opt/chromium/chrome-sandbox EACCES");
  expect(errorLine()).toContain("computer-use.failure-logging.test.ts"); // the stack came along
});

it("logs the driver's own diagnosis, with the operation and both identifiers, without widening the response", async () => {
  const observe = vi.fn().mockRejectedValue(Object.assign(new Error(SANDBOX), { code: "unsupported" }));
  vi.mocked(getComputerUseHost).mockResolvedValue({ observe } as never);

  const response = await post("chat-77/sess-3/observe", {});

  // Unchanged behaviour: a coded error already reached the client verbatim.
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "unsupported", error: SANDBOX });

  expect(logs.error).toHaveBeenCalledOnce();
  expect(errorLine()).toContain("observe chat=chat-77 session=sess-3 code=unsupported");
  expect(errorLine()).toContain("permit Chromium's sandbox");
});

it("keeps routine refusals out of the error log", async () => {
  const host = {
    status: vi.fn().mockRejectedValue(Object.assign(new Error("Chat not found"), { code: "not_found" })),
    approve: vi.fn().mockRejectedValue(Object.assign(new Error("Approval expired"), { code: "approval_required" })),
    action: vi.fn(),
    stop: vi.fn().mockRejectedValue(Object.assign(new Error("Refresh the viewer"), { code: "stale_frame" })),
  };
  vi.mocked(getComputerUseHost).mockResolvedValue(host as never);

  const responses = [
    await fetch(`${origin}/api/computer-use/chat-77/status`),
    await post("chat-77/sess-3/approve", {}),
    await post("chat-77/sess-3/stop", {}),
    // Route-level validation: a missing frame token never reaches the host.
    await post("chat-77/sess-3/action", { action: { type: "click", x: 1, y: 2 } }),
  ];

  expect(responses.map((r) => r.status)).toEqual([404, 403, 409, 400]);
  expect(host.action).not.toHaveBeenCalled();
  expect(logs.error).not.toHaveBeenCalled();
  expect(logs.warn).not.toHaveBeenCalled();
  expect(logs.debug).toHaveBeenCalledTimes(4);
  expect(String(logs.debug.mock.calls.at(-1)?.[0])).toContain("action chat=chat-77 session=sess-3 code=invalid_request");
});

it("keeps a refusal an operator must see at the default level, without calling it a fault", async () => {
  vi.mocked(getComputerUseHost).mockResolvedValue({
    status: vi.fn().mockRejectedValue(Object.assign(new Error("Chat permission metadata is unreadable"), { code: "denied" })),
  } as never);

  expect((await fetch(`${origin}/api/computer-use/chat-77/status`)).status).toBe(403);

  // `denied` is not a driver fault, so not error — but it is the one refusal
  // that is invisible at `info` everywhere else: the service emits no audit
  // event for it, and a corrupt chat file lands here too.
  expect(logs.error).not.toHaveBeenCalled();
  expect(logs.debug).not.toHaveBeenCalled();
  expect(logs.warn).toHaveBeenCalledOnce();
  expect(String(logs.warn.mock.calls[0][0])).toContain("status chat=chat-77 code=denied refused: Chat permission metadata is unreadable");
});

it("folds a message onto our line, and does not let it forge a line or a frame", async () => {
  // A zod issue prints the offending key verbatim, newlines and all. The last
  // two entries are the separators that are not control characters: `less`
  // ignores them, but CSS `white-space: pre` breaks on U+2028.
  const zodish =
    'Invalid arguments: [\n  {\n    "code": "unrecognized_keys",\n    "keys": [\n      "[error] forged"\n    ]\n  }\n]' +
    "\n    at forged (/evil.js:1:1)\u2028[error] split\u0085more";
  vi.mocked(getComputerUseHost).mockResolvedValue({ observe: vi.fn().mockRejectedValue(new Error(zodish)) } as never);

  expect((await post("chat-77/sess-3/observe", {})).status).toBe(503);

  const [header, ...frames] = errorLine().split("\n");
  expect(header).toContain("unrecognized_keys");
  expect(header).toContain("[error] forged"); // preserved — it is the diagnosis — but on our line
  expect(header).toContain("[error] split");
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every((line) => /^\s+at /.test(line))).toBe(true);
  // The message's own "at ..." line matches that filter, so it has to be cut
  // with the header it lives in, not filtered out line by line.
  expect(frames.some((line) => line.includes("/evil.js"))).toBe(false);
  expect(errorLine()).toContain("computer-use.failure-logging.test.ts"); // real frames survived
});

it("keeps an errno greppable as a code even though it is not one of our own", async () => {
  vi.mocked(getComputerUseHost).mockResolvedValue({
    open: vi.fn().mockRejectedValue(Object.assign(new Error("spawn chromium ENOENT"), { code: "ENOENT" })),
  } as never);

  expect((await post("chat-77/open", { kind: "browser" })).status).toBe(503);

  expect(logs.error).toHaveBeenCalledOnce();
  expect(errorLine()).toContain("code=ENOENT");
});

it("never lets a request-supplied identifier forge a log line", async () => {
  vi.mocked(getComputerUseHost).mockResolvedValue({ status: vi.fn() } as never);

  expect((await fetch(`${origin}/api/computer-use/ch%0a%5BERROR%5D%20at/status`)).status).toBe(400);

  expect(logs.error).not.toHaveBeenCalled();
  const line = String(logs.debug.mock.calls.at(0)?.[0] ?? "");
  expect(line).toContain("chat=chERRORat");
  expect(line).not.toContain("\n");
});
