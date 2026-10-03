import { describe, it, expect } from "vitest";
import type { CronJob } from "../../../api";
import { EMPTY_CRON_JOB_FORM, cronJobCreatePayload, cronJobFormFromJob, cronJobUpdatePayload, isCronJobFormComplete } from "./cronJobForm";

const job: CronJob = {
  id: "job-1",
  name: "Daily review",
  description: "Review",
  status: "active",
  type: "recurring",
  schedule: "0 9 * * *",
  action: { type: "send_message", provider: "codex", model: "gpt-x", effort: "high", prompt: "go", folder: "/f", maxTurns: 3, requireExplicitCompletion: true },
  quietHours: { enabled: true, start: "23:00", end: "06:00" },
  skipIfRunning: true,
};

describe("cronJobCreatePayload", () => {
  it("omits every default, trimming text and dropping a blank prompt", () => {
    const form = { ...EMPTY_CRON_JOB_FORM, name: " n ", schedule: " 0 9 * * * ", description: " d ", prompt: "   " };
    expect(cronJobCreatePayload(form)).toStrictEqual({
      name: "n",
      schedule: "0 9 * * *",
      type: "recurring",
      status: "active",
      description: "d",
      action: { type: "start_session", prompt: undefined },
    });
  });

  it("sends provider, the active provider's model, effort, completion, quiet hours and skip when set", () => {
    const form = {
      ...EMPTY_CRON_JOB_FORM,
      name: "n",
      schedule: "s",
      description: "d",
      prompt: " p ",
      type: "one-off" as const,
      provider: "cline" as const,
      models: { "claude-code": "opus", cline: " openai/x " },
      effort: "high" as const,
      requireCompletion: true,
      qhEnabled: true,
      qhStart: "21:00",
      qhEnd: "05:00",
      skipIfRunning: true,
    };
    expect(cronJobCreatePayload(form)).toStrictEqual({
      name: "n",
      schedule: "s",
      type: "one-off",
      status: "active",
      description: "d",
      action: { type: "start_session", prompt: "p", provider: "cline", model: "openai/x", effort: "high", requireExplicitCompletion: true },
      quietHours: { enabled: true, start: "21:00", end: "05:00" },
      skipIfRunning: true,
    });
  });

  it("drops effort for Claude Code and omits its provider", () => {
    const form = {
      ...EMPTY_CRON_JOB_FORM,
      name: "n",
      schedule: "s",
      description: "d",
      models: { "claude-code": "sonnet", codex: "gpt" },
      effort: "high" as const,
    };
    expect(cronJobCreatePayload(form).action).toStrictEqual({ type: "start_session", prompt: undefined, model: "sonnet" });
  });
});

describe("cronJobFormFromJob / cronJobUpdatePayload", () => {
  it("hydrates the stored model under the stored provider only", () => {
    const form = cronJobFormFromJob(job);
    expect(form.provider).toBe("codex");
    expect(form.models).toStrictEqual({ codex: "gpt-x" });
    expect(form).toMatchObject({
      prompt: "go",
      qhEnabled: true,
      qhStart: "23:00",
      qhEnd: "06:00",
      skipIfRunning: true,
      requireCompletion: true,
      effort: "high",
    });
  });

  it("re-targets a retired OpenRouter cron to Claude Code and drops its model", () => {
    const form = cronJobFormFromJob({ ...job, action: { type: "start_session", provider: "openrouter" as never, model: "x/y" } });
    expect(form.provider).toBe("claude-code");
    expect(form.models).toStrictEqual({});
  });

  it("defaults quiet hours and flags for a bare job", () => {
    const form = cronJobFormFromJob({ ...job, action: { type: "start_session" }, quietHours: undefined, skipIfRunning: undefined });
    expect(form).toMatchObject({
      provider: "claude-code",
      models: { "claude-code": "" },
      qhEnabled: false,
      qhStart: "22:00",
      qhEnd: "07:00",
      skipIfRunning: false,
    });
  });

  it("round-trips an untouched job, preserving unowned action fields and order", () => {
    const body = cronJobUpdatePayload(cronJobFormFromJob(job), job.action);
    expect(body).toStrictEqual({
      name: "Daily review",
      schedule: "0 9 * * *",
      type: "recurring",
      description: "Review",
      action: {
        type: "send_message",
        folder: "/f",
        maxTurns: 3,
        prompt: "go",
        provider: "codex",
        model: "gpt-x",
        effort: "high",
        requireExplicitCompletion: true,
      },
      quietHours: { enabled: true, start: "23:00", end: "06:00" },
      skipIfRunning: true,
    });
    expect(Object.keys(body.action!)).toEqual(["type", "folder", "maxTurns", "prompt", "provider", "model", "effort", "requireExplicitCompletion"]);
  });

  it("always sends quiet hours and skip-if-running, so unticking clears them", () => {
    const form = { ...cronJobFormFromJob(job), qhEnabled: false, skipIfRunning: false, requireCompletion: false, provider: "claude-code" as const };
    const body = cronJobUpdatePayload(form, job.action);
    expect(body.quietHours).toStrictEqual({ enabled: false, start: "23:00", end: "06:00" });
    expect(body.skipIfRunning).toBe(false);
    expect(body.action).toStrictEqual({ type: "send_message", folder: "/f", maxTurns: 3, prompt: "go" });
  });

  it("defaults the action type when the job has no stored action", () => {
    expect(cronJobUpdatePayload(EMPTY_CRON_JOB_FORM, undefined).action).toStrictEqual({ type: "start_session", prompt: undefined });
  });
});

describe("isCronJobFormComplete", () => {
  it("requires name, schedule and description", () => {
    expect(isCronJobFormComplete({ ...EMPTY_CRON_JOB_FORM, name: "n", schedule: "s", description: "d" })).toBe(true);
    expect(isCronJobFormComplete({ ...EMPTY_CRON_JOB_FORM, name: "n", schedule: " ", description: "d" })).toBe(false);
  });
});
