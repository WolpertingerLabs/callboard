/**
 * The unattended-work guard (permission-ceiling.ts `guardUnattendedTools`) on
 * the real tool servers.
 *
 * Every tool here creates, changes or starts a session that runs allow-all
 * with nobody watching — a job step, an agent run, a cron or trigger firing.
 * Pre-approved and in-process, they were a second route from an "ask" chat to
 * a shell: `create_job` + `spawn_job` was two tool calls. So each is refused
 * unless the caller is already allow-all, and a server built without the
 * permission getter fails closed.
 *
 * The allow-all case uses arguments the real handler rejects on its own (an
 * unknown agent, malformed JSON) or a mocked store, so "not refused by the
 * guard" is observable without starting anything.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DefaultPermissions } from "shared/types/index.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-unattended-guard-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

// callboard-tools imports claude.ts, which registers itself back at load.
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));

// The two tools whose real handler would persist and schedule something.
const createCronJob = vi.fn(() => ({ id: "cron-1", status: "paused" }));
const createTrigger = vi.fn(() => ({ id: "trigger-1" }));
vi.mock("./agent-cron-jobs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-cron-jobs.js")>()),
  createCronJob: (...args: unknown[]) => createCronJob(...(args as [])),
}));
vi.mock("./agent-triggers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-triggers.js")>()),
  createTrigger: (...args: unknown[]) => createTrigger(...(args as [])),
}));
vi.mock("./cron-scheduler.js", () => ({ scheduleJob: vi.fn(), cancelJob: vi.fn() }));

const { buildAgentToolsSpec, AGENT_UNATTENDED_TOOLS } = await import("./agent-tools.js");
const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
const { JOB_UNATTENDED_TOOLS } = await import("./job-management-tools.js");
const { unattendedPermissions } = await import("./session-spawn.js");
import type { AnyToolDefinition, ToolCallResult, ToolServerSpec } from "../agents/ports/tools.js";

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  createCronJob.mockClear();
  createTrigger.mockClear();
});

/** Arguments each real handler accepts as input but stops on without side effects (or hits a mock). */
const ARGS: Record<string, Record<string, unknown>> = {
  talk_to_agent: { targetAlias: "no-such-agent", message: "hi" },
  deploy_agent: { targetAlias: "no-such-agent", prompt: "hi" },
  create_cron_job: { name: "n", schedule: "0 * * * *", prompt: "p" },
  update_cron_job: { jobId: "no-such-cron", name: "n" },
  create_trigger: { name: "n", prompt: "p" },
  update_trigger: { triggerId: "no-such-trigger", name: "n" },
  create_agent: { alias: "Not A Valid Alias!", name: "n", description: "d" },
  update_agent: { alias: "no-such-agent", name: "n" },
  create_job: { definition_json: "{" },
  update_job: { jobId: "no-such-job", definition_json: "{" },
  spawn_job: { jobId: "no-such-job" },
  retry_job_step: { runId: "no-such-run" },
  resume_job_run: { runId: "no-such-run" },
};

const ALLOW_ALL = (): DefaultPermissions => unattendedPermissions();
const ASK_EXEC = (): DefaultPermissions => ({ ...unattendedPermissions(), codeExecution: "ask" });

type Getter = (() => DefaultPermissions | null) | undefined;

const SERVERS: { label: string; names: readonly string[]; build: (getPermissions: Getter) => ToolServerSpec }[] = [
  {
    label: "agent server (callboard)",
    names: [...AGENT_UNATTENDED_TOOLS, ...JOB_UNATTENDED_TOOLS],
    build: (getPermissions) => buildAgentToolsSpec("test-agent", () => "agent-chat", getPermissions ? { getPermissions } : undefined),
  },
  {
    label: "chat server (callboard-tools)",
    names: JOB_UNATTENDED_TOOLS,
    build: (getPermissions) => buildCallboardToolsSpec(() => "chat", undefined, getPermissions ? { getPermissions } : undefined),
  },
];

function tool(spec: ToolServerSpec, name: string): AnyToolDefinition {
  const found = spec.tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found on ${spec.name}`);
  return found;
}

/** The text of a tool result's text blocks. */
function textOf(result: ToolCallResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

async function call(spec: ToolServerSpec, name: string): Promise<string> {
  return textOf(await tool(spec, name).handler(ARGS[name]));
}

describe.each(SERVERS)("$label", ({ names, build }) => {
  it.each(names)("refuses %s for a caller that asks for code execution", async (name) => {
    const text = await call(build(ASK_EXEC), name);
    expect(JSON.parse(text)).toMatchObject({ ok: false, error: "permission_ceiling", tool: name, looserCategories: ["codeExecution"] });
  });

  it.each(names)("fails closed on %s when the server was built without a permission getter", async (name) => {
    const text = await call(build(undefined), name);
    expect(JSON.parse(text)).toMatchObject({ error: "permission_ceiling", looserCategories: ["fileRead", "fileWrite", "codeExecution", "webAccess"] });
  });

  it.each(names)("leaves %s unchanged for an allow-all caller", async (name) => {
    const text = await call(build(ALLOW_ALL), name);
    expect(text).not.toContain("permission_ceiling");
  });
});

describe("side effects", () => {
  it("an ask caller's create_cron_job / create_trigger never reach the store", async () => {
    const spec = buildAgentToolsSpec("test-agent", () => "agent-chat", { getPermissions: ASK_EXEC });
    await call(spec, "create_cron_job");
    await call(spec, "create_trigger");
    expect(createCronJob).not.toHaveBeenCalled();
    expect(createTrigger).not.toHaveBeenCalled();
  });

  it("an allow-all caller's create_cron_job / create_trigger do", async () => {
    const spec = buildAgentToolsSpec("test-agent", () => "agent-chat", { getPermissions: ALLOW_ALL });
    await call(spec, "create_cron_job");
    await call(spec, "create_trigger");
    expect(createCronJob).toHaveBeenCalledTimes(1);
    expect(createTrigger).toHaveBeenCalledTimes(1);
  });
});

describe("guard surface", () => {
  it("leaves read-only and unrelated tools unguarded for an ask caller", async () => {
    const spec = buildAgentToolsSpec("test-agent", () => "agent-chat", { getPermissions: ASK_EXEC });
    const result = await tool(spec, "list_cron_jobs").handler({});
    expect(textOf(result)).not.toContain("permission_ceiling");
  });
});
