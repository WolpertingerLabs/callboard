/**
 * Status mapping in the jobs routes: typed errors (JobNotFoundError → 404,
 * JobConflictError → 409) keep their status and message; an untyped error is a
 * 500 even when its message happens to contain "not found" / "is not".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-jobs-errors-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

vi.mock("../services/job-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/job-runner.js")>();
  return {
    ...actual,
    pauseRun: () => {
      throw new TypeError("run.history is not iterable");
    },
    resumeRun: () => {
      throw new Error("some dependency not found");
    },
  };
});

// Codex routed through OpenRouter, so an OpenRouter-unsupported effort is refused.
vi.mock("../services/agent-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/agent-settings.js")>()),
  getAgentSettings: () => ({ codexUseOpenRouter: true, codexOpenRouterApiKey: "fake" }),
}));

const { createJob, createRun, getJob, saveRun } = await import("../services/job-store.js");
const { jobsRouter } = await import("./jobs.js");

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const payload = {
  id: "err-flow",
  name: "Err Flow",
  steps: [{ id: "ok", type: "approval", message: "Proceed?" }],
};

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/jobs${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

describe("jobs route error statuses", () => {
  it("409 with the original message when creating a duplicate job", async () => {
    createJob(payload as never);
    const res = await post("/", payload);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Job "err-flow" already exists — use update_job to modify it');
  });

  it("404 when updating a missing job", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/nope`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, id: "nope" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Job "nope" not found');
  });

  it("404 when spawning a missing job or acting on a missing run", async () => {
    const spawn = await post("/nope/spawn");
    expect(spawn.status).toBe(404);
    expect((await spawn.json()).error).toBe('Job "nope" not found');

    const cancel = await post("/runs/nope/cancel");
    expect(cancel.status).toBe(404);
    expect((await cancel.json()).error).toBe('Job run "nope" not found');
  });

  it("409 when cancelling a run that already ended", async () => {
    const run = createRun(getJob("err-flow") ?? createJob(payload as never), {});
    saveRun({ ...run, status: "succeeded" });
    const res = await post(`/runs/${run.runId}/cancel`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(`Run ${run.runId} already ended (status: succeeded)`);
  });

  it("409 when retrying a failed run that has no current step", async () => {
    const run = createRun(getJob("err-flow") ?? createJob(payload as never), {});
    saveRun({ ...run, status: "failed", currentStepId: null });
    const res = await post(`/runs/${run.runId}/retry-step`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(`Run ${run.runId} has no current step to retry`);
  });

  it("400, as a validation error, for a reasoning effort the routed endpoint does not support", async () => {
    // The message says "is not supported", but it never reaches the route
    // untyped: assertJobReasoningEfforts wraps it in a JobValidationError.
    const step = { id: "one", type: "agent", prompt: "go", provider: "codex", folder: "{{inputs.repo}}", effort: "ultra" };
    const res = await post("/", { id: "effort-flow", name: "Effort Flow", steps: [step] });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual(['Step "one": Reasoning effort "ultra" is not supported by OpenRouter.']);
  });

  it("500 for an untyped error whose message merely contains 'is not' or 'not found'", async () => {
    const pause = await post("/runs/any/pause");
    expect(pause.status).toBe(500);
    expect((await pause.json()).error).toBe("run.history is not iterable");

    const resume = await post("/runs/any/resume");
    expect(resume.status).toBe(500);
  });
});
