/**
 * Unit + route tests for job definition import/export.
 *
 * DATA_DIR is resolved from CALLBOARD_DATA_DIR when utils/paths.js first loads,
 * so the env var is set before any store/route module is imported (hence the
 * top-level dynamic imports) — each test file gets its own throwaway data dir.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-job-import-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const {
  createJob,
  getJob,
  listJobs,
  exportJobEnvelope,
  uniqueJobId,
  importJobDefinition,
  JobValidationError,
  JobImportConflictError,
} = await import("./job-store.js");
const { jobsRouter } = await import("../routes/jobs.js");
type JobDefinitionInput = import("./job-store.js").JobDefinitionInput;

const definitionsDir = join(tmpRoot, "jobs", "definitions");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe every definition between tests so ids don't bleed across cases.
  for (const file of readdirSync(definitionsDir).filter((f) => f.endsWith(".json"))) {
    rmSync(join(definitionsDir, file), { force: true });
  }
});

/** A minimal, valid two-step definition payload. */
function samplePayload(overrides: Record<string, unknown> = {}): JobDefinitionInput {
  return {
    id: "greet-flow",
    name: "Greet Flow",
    description: "Says hello then signs off",
    inputs: [{ key: "who" }],
    steps: [
      { id: "hello", type: "agent", prompt: "Greet {{inputs.who}}", outputs: ["greeting"] },
      { id: "bye", type: "agent", prompt: "Say goodbye after {{steps.hello.outputs.greeting}}" },
    ],
    ...overrides,
  } as JobDefinitionInput;
}

describe("exportJobEnvelope", () => {
  it("returns null for a missing job", () => {
    expect(exportJobEnvelope("does-not-exist")).toBeNull();
  });

  it("wraps the definition in an envelope with server fields stripped", () => {
    createJob({ ...samplePayload(), createdBy: { kind: "ui" } });
    const env = exportJobEnvelope("greet-flow");
    expect(env).not.toBeNull();
    expect(env!.callboardJobExport).toBe(1);
    expect(typeof env!.exportedAt).toBe("string");
    expect(new Date(env!.exportedAt).toISOString()).toBe(env!.exportedAt);

    // Payload keeps the definition fields …
    expect(env!.job.id).toBe("greet-flow");
    expect(env!.job.name).toBe("Greet Flow");
    expect(env!.job.steps).toHaveLength(2);
    // … but drops every server-managed field.
    expect(env!.job).not.toHaveProperty("version");
    expect(env!.job).not.toHaveProperty("createdAt");
    expect(env!.job).not.toHaveProperty("updatedAt");
    expect(env!.job).not.toHaveProperty("createdBy");
  });
});

describe("uniqueJobId", () => {
  it("returns the plain slug when free", () => {
    expect(uniqueJobId("Greet Flow")).toBe("greet-flow");
  });

  it("appends -2, -3, … past existing collisions", () => {
    createJob(samplePayload({ id: "greet-flow" }));
    expect(uniqueJobId("greet-flow")).toBe("greet-flow-2");
    createJob(samplePayload({ id: "greet-flow-2" }));
    expect(uniqueJobId("greet-flow")).toBe("greet-flow-3");
  });
});

describe("importJobDefinition", () => {
  it("round-trips export → import to an equal definition", () => {
    createJob({ ...samplePayload(), createdBy: { kind: "ui" } });
    const env = exportJobEnvelope("greet-flow")!;
    const original = getJob("greet-flow")!;

    // Re-import over the same id.
    const imported = importJobDefinition(env, { mode: "overwrite" });

    // Same id and the same portable payload.
    expect(imported.id).toBe(original.id);
    expect(exportJobEnvelope(imported.id)!.job).toEqual(env.job);
  });

  it("accepts a bare definition object (no envelope)", () => {
    const job = importJobDefinition(samplePayload());
    expect(job.id).toBe("greet-flow");
    expect(job.createdBy).toEqual({ kind: "api" });
    expect(getJob("greet-flow")).not.toBeNull();
  });

  it("derives the id from the name when none is given", () => {
    const job = importJobDefinition(samplePayload({ id: undefined, name: "Brand New Job" }));
    expect(job.id).toBe("brand-new-job");
  });

  it("strips server-managed fields present in the input", () => {
    const job = importJobDefinition({
      ...samplePayload(),
      version: 99,
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
      createdBy: { kind: "chat", ref: "smuggled" },
    });
    expect(job.version).toBe(1);
    expect(job.createdBy).toEqual({ kind: "api" });
    expect(job.createdAt).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("rejects an unknown envelope version", () => {
    expect(() => importJobDefinition({ callboardJobExport: 2, job: samplePayload() })).toThrow(/version/i);
  });

  it("propagates JobValidationError for an invalid definition", () => {
    expect(() => importJobDefinition(samplePayload({ steps: [] }))).toThrow(JobValidationError);
  });

  it("throws JobImportConflictError on an id collision with no mode", () => {
    createJob(samplePayload());
    try {
      importJobDefinition(samplePayload());
      expect.unreachable("expected a conflict");
    } catch (err) {
      expect(err).toBeInstanceOf(JobImportConflictError);
      expect((err as InstanceType<typeof JobImportConflictError>).jobId).toBe("greet-flow");
    }
  });

  it('mode "copy" assigns a suffixed unique id and leaves the original intact', () => {
    const original = createJob({ ...samplePayload(), createdBy: { kind: "ui" } });
    const copy = importJobDefinition(samplePayload(), { mode: "copy" });

    expect(copy.id).toBe("greet-flow-2");
    expect(copy.version).toBe(1);
    // Original untouched.
    const stillThere = getJob("greet-flow")!;
    expect(stillThere.createdBy).toEqual({ kind: "ui" });
    expect(stillThere.version).toBe(original.version);
    expect(listJobs().map((j) => j.id).sort()).toEqual(["greet-flow", "greet-flow-2"]);
  });

  it('mode "overwrite" bumps version and keeps the same id', () => {
    createJob(samplePayload());
    const updated = importJobDefinition(samplePayload({ name: "Greet Flow v2" }), { mode: "overwrite" });
    expect(updated.id).toBe("greet-flow");
    expect(updated.version).toBe(2);
    expect(updated.name).toBe("Greet Flow v2");
    expect(listJobs()).toHaveLength(1);
  });
});

// ── Route-level shapes ──────────────────────────────────────────────

describe("jobs import/export routes", () => {
  let baseUrl = "";
  let server: Server | undefined;

  beforeEach(async () => {
    if (server) return;
    const app = express();
    app.use(express.json());
    app.use("/api/jobs", jobsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server?.close();
  });

  it("GET /:id/export returns a download envelope, 404 when missing", async () => {
    createJob(samplePayload());

    const ok = await fetch(`${baseUrl}/api/jobs/greet-flow/export`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("application/json");
    expect(ok.headers.get("content-disposition")).toBe('attachment; filename="greet-flow.job.json"');
    const body = await ok.json();
    expect(body.callboardJobExport).toBe(1);
    expect(body.job.id).toBe("greet-flow");

    const missing = await fetch(`${baseUrl}/api/jobs/nope/export`);
    expect(missing.status).toBe(404);
  });

  it("POST /import returns 201 with the created job", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callboardJobExport: 1, exportedAt: "x", job: samplePayload() }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.job.id).toBe("greet-flow");
    expect(body.job.createdBy).toEqual({ kind: "api" });
  });

  it("POST /import returns 409 with conflict.id on a bare collision", async () => {
    createJob(samplePayload());
    const res = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(samplePayload()),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.conflict).toEqual({ id: "greet-flow" });
    expect(typeof body.error).toBe("string");
  });

  it("POST /import resolves a collision with mode copy (201)", async () => {
    createJob(samplePayload());
    const res = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...samplePayload(), mode: "copy" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).job.id).toBe("greet-flow-2");
  });

  it("POST /import returns 400 for an invalid definition", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(samplePayload({ steps: [] })),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(Array.isArray(body.errors)).toBe(true);
  });

  it("POST /import returns 400 for an unknown envelope version", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callboardJobExport: 7, job: samplePayload() }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/version/i);
  });
});
