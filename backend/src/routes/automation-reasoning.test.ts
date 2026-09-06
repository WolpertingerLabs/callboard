import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const stubs = vi.hoisted(() => ({ validate: vi.fn(async (_input: unknown) => {}), create: vi.fn(), update: vi.fn() }));
vi.mock("../services/reasoning-capabilities.js", () => ({ assertReasoningEffort: stubs.validate }));
vi.mock("../services/agent-file-service.js", () => ({ agentExists: () => true, getAgent: () => ({}) }));
vi.mock("../services/agent-cron-jobs.js", () => ({
  listCronJobs: () => [],
  getCronJob: () => ({}),
  createCronJob: stubs.create,
  updateCronJob: stubs.update,
  deleteCronJob: vi.fn(),
}));
vi.mock("../services/agent-triggers.js", () => ({
  listTriggers: () => [],
  getTrigger: () => ({}),
  createTrigger: stubs.create,
  updateTrigger: stubs.update,
  deleteTrigger: vi.fn(),
}));
vi.mock("../services/cron-scheduler.js", () => ({ scheduleJob: vi.fn(), cancelJob: vi.fn() }));
vi.mock("../services/agent-executor.js", () => ({ executeAgent: vi.fn() }));
vi.mock("../services/trigger-dispatcher.js", () => ({ backtestFilter: vi.fn() }));
vi.mock("../services/agent-activity.js", () => ({ appendActivity: vi.fn() }));
const { agentCronJobsRouter } = await import("./agent-cron-jobs.js");
const { agentTriggersRouter } = await import("./agent-triggers.js");
beforeEach(() => {
  vi.clearAllMocks();
  stubs.validate.mockResolvedValue(undefined);
  stubs.create.mockImplementation((_alias, input) => ({ id: "one", ...input }));
  stubs.update.mockImplementation((_alias, _id, input) => ({ id: "one", ...input }));
});
describe.each([
  ["cron", agentCronJobsRouter, "jobId"],
  ["trigger", agentTriggersRouter, "triggerId"],
] as const)("%s reasoning API", (_name, router, id) => {
  async function request(method: "post" | "put", action: unknown) {
    const layer = (router as any).stack.find((entry: any) => entry.route?.path === (method === "post" ? "/" : `/:${id}`) && entry.route.methods[method]);
    let status = 200;
    let body: any;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    };
    await layer.route.stack[0].handle(
      {
        params: { alias: "agent", [id]: "one" },
        body: { name: "test", schedule: "0 9 * * *", type: "recurring", description: "test", filter: {}, action },
      } as unknown as Request,
      res as unknown as Response,
    );
    return { status, body };
  }
  it.each(["post", "put"] as const)("rejects invalid %s before writes", async (method) => {
    stubs.validate.mockRejectedValueOnce(new Error("ultra unsupported for selected model"));
    const result = await request(method, { type: "start_session", provider: "codex", model: "luna", effort: "ultra" });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("ultra");
    expect(stubs.create).not.toHaveBeenCalled();
    expect(stubs.update).not.toHaveBeenCalled();
  });
  it("preserves validated max", async () => {
    const action = { type: "start_session", provider: "codex", model: "luna", effort: "max" };
    const result = await request("post", action);
    expect(result.status).toBe(201);
    expect(stubs.validate).toHaveBeenCalledWith(action);
    expect(stubs.create.mock.calls[0][1].action).toEqual(action);
  });
});
