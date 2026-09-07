/**
 * Route-level tests for `journalTokenBudget` on PUT /api/agents/:alias.
 *
 * The handler rebuilds the config from an explicit destructure of the body, so
 * a field that isn't named there is silently dropped — the save returns 200 and
 * the setting simply never persists. That failure is invisible from the
 * compiler tests (they take the budget as an argument), so it gets pinned here.
 *
 * The handler is pulled off the router stack and driven with a fake req/res,
 * matching the no-supertest style in agent-settings.partial-update.test.ts.
 * Sub-routers and the fan-out to scheduler/proxy are stubbed.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-agents-route-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("./agent-workspace.js", () => ({ agentWorkspaceRouter: Router() }));
vi.mock("./agent-memory.js", () => ({ agentMemoryRouter: Router() }));
vi.mock("./agent-cron-jobs.js", () => ({ agentCronJobsRouter: Router(), ensureDefaultCronJobs: () => [], listCronJobs: () => [] }));
vi.mock("./agent-activity.js", () => ({ agentActivityRouter: Router(), appendActivity: () => {} }));
vi.mock("./agent-triggers.js", () => ({ agentTriggersRouter: Router() }));
vi.mock("./agent-export-import.js", () => ({ agentExportImportRouter: Router() }));
vi.mock("../services/agent-cron-jobs.js", () => ({ ensureDefaultCronJobs: () => [], listCronJobs: () => [] }));
vi.mock("../services/agent-activity.js", () => ({ appendActivity: () => {} }));
vi.mock("../services/cron-scheduler.js", () => ({ cancelAllJobsForAgent: () => {}, scheduleJob: () => {} }));
vi.mock("../services/proxy-singleton.js", () => ({ ensureCallerEnrolled: async () => {} }));

const { agentsRouter } = await import("./agents.js");
const { createAgent, getAgent } = await import("../services/agent-file-service.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Pull the PUT /:alias handler off the router stack. */
const putHandler = (agentsRouter as any).stack.find((layer: any) => layer.route?.path === "/:alias" && layer.route.methods.put).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function callPut(alias: string, body: Record<string, unknown>): { status: number; payload: unknown } {
  let status = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(data: unknown) {
      payload = data;
      return this;
    },
  } as unknown as Response;

  putHandler({ params: { alias }, body } as unknown as Request, res);
  return { status, payload };
}

describe("PUT /api/agents/:alias — journalTokenBudget", () => {
  beforeEach(() => {
    createAgent({ name: "Budget Agent", alias: "budget-agent", description: "fixture", createdAt: 0 });
  });

  it("persists the budget to agent.json", () => {
    const { status } = callPut("budget-agent", { journalTokenBudget: 8000 });

    expect(status).toBe(200);
    expect(getAgent("budget-agent")?.journalTokenBudget).toBe(8000);
  });

  it("persists 0 — the explicit 'no truncation' choice, not an absent field", () => {
    callPut("budget-agent", { journalTokenBudget: 8000 });
    const { status } = callPut("budget-agent", { journalTokenBudget: 0 });

    expect(status).toBe(200);
    expect(getAgent("budget-agent")?.journalTokenBudget).toBe(0);
  });

  it("leaves an existing budget alone when the field is absent from the body", () => {
    callPut("budget-agent", { journalTokenBudget: 8000 });
    callPut("budget-agent", { name: "Renamed Agent" });

    const agent = getAgent("budget-agent");
    expect(agent?.name).toBe("Renamed Agent");
    expect(agent?.journalTokenBudget).toBe(8000);
  });

  it.each([
    ["a negative budget", -1],
    ["a non-integer budget", 1500.5],
    ["an absurdly large budget", 500_000],
  ])("rejects %s without persisting it", (_label, value) => {
    const { status } = callPut("budget-agent", { journalTokenBudget: value });

    expect(status).toBe(400);
    expect(getAgent("budget-agent")?.journalTokenBudget).toBeUndefined();
  });
});
