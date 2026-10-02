/**
 * The `/:alias/...` sub-routers sit behind one `requireAgent` gate in
 * agents.ts: a malformed alias (it is joined into a filesystem path) is a 400
 * before any handler runs, an unknown one is the same 404 body the sub-routers
 * used to send themselves, and a valid one reaches the sub-router with
 * `req.params.alias` intact (mergeParams).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { Router } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-require-agent-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const reached = vi.hoisted(() => vi.fn());

vi.mock("./agent-memory.js", async () => {
  const { Router: R } = await import("express");
  const router = R({ mergeParams: true });
  router.get("/", (req, res) => {
    const { alias } = req.params as { alias: string };
    reached(alias);
    res.json({ alias });
  });
  return { agentMemoryRouter: router };
});
vi.mock("./agent-workspace.js", () => ({ agentWorkspaceRouter: Router() }));
vi.mock("./agent-cron-jobs.js", () => ({ agentCronJobsRouter: Router() }));
vi.mock("./agent-activity.js", () => ({ agentActivityRouter: Router() }));
vi.mock("./agent-triggers.js", () => ({ agentTriggersRouter: Router() }));
vi.mock("./agent-export-import.js", () => ({ agentExportImportRouter: Router() }));
vi.mock("../services/agent-cron-jobs.js", () => ({ ensureDefaultCronJobs: () => [], listCronJobs: () => [] }));
vi.mock("../services/agent-activity.js", () => ({ appendActivity: () => {} }));
vi.mock("../services/cron-scheduler.js", () => ({ cancelAllJobsForAgent: () => {}, scheduleJob: () => {} }));

const { agentsRouter } = await import("./agents.js");
const { createAgent } = await import("../services/agent-file-service.js");

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  createAgent({ name: "Real Agent", alias: "real-agent", description: "fixture", createdAt: 0 });
  const app = express();
  app.use("/api/agents", agentsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("requireAgent", () => {
  it("passes an existing agent through with req.params.alias intact", async () => {
    const res = await fetch(`${baseUrl}/api/agents/real-agent/memory`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alias: "real-agent" });
  });

  it("404s an unknown agent with the existing body", async () => {
    reached.mockClear();
    const res = await fetch(`${baseUrl}/api/agents/no-such-agent/memory`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Agent not found" });
    expect(reached).not.toHaveBeenCalled();
  });

  it.each(["..%2F..%2Fetc", "Upper", "a", "-leading"])("400s a malformed alias %s before any handler runs", async (alias) => {
    reached.mockClear();
    const res = await fetch(`${baseUrl}/api/agents/${alias}/memory`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid agent alias" });
    expect(reached).not.toHaveBeenCalled();
  });
});
