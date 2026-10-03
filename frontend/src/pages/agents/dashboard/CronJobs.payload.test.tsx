import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CronJobs from "./CronJobs";
import { resetSystemInfoCache } from "../../../api";
import type { AgentConfig, CronJob } from "../../../api";

/**
 * The exact request bodies the New Job and inline Edit forms send, through the
 * real rendered forms. `cronJobForm.test.ts` covers the mapping in isolation;
 * this pins the wiring from inputs to it.
 */

const agent = { alias: "test-agent", workspacePath: "/project" } as AgentConfig;
const savedJob: CronJob = {
  id: "job-1",
  name: "Daily review",
  description: "Review",
  status: "active",
  type: "recurring",
  schedule: "0 9 * * *",
  action: { type: "start_session", provider: "codex", model: "gpt-x", prompt: "go", folder: "/cron-folder", maxTurns: 33 },
  quietHours: { enabled: true, start: "23:00", end: "06:00" },
};

function serve(jobs: CronJob[] = []) {
  const writes: Array<{ method: string; payload: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let body: unknown = { models: [], aliases: [] };
      if (init?.method === "PUT" || init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        writes.push({ method: init.method, payload });
        body = { job: { ...savedJob, ...payload } };
      } else if (url.includes("/system-info")) body = { codexConfigured: true };
      else if (url.includes("/codex/reasoning")) body = { efforts: [], status: "known" };
      else if (url.endsWith("/cron-jobs")) body = { jobs };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
    }),
  );
  return writes;
}

beforeEach(() => resetSystemInfoCache());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CronJobs form payloads", () => {
  it("creates a job with quiet hours, skip-if-running and completion ticked", async () => {
    const writes = serve();
    render(<CronJobs agent={agent} />);
    fireEvent.click(await screen.findByRole("button", { name: "New Job" }));
    fireEvent.change(screen.getByPlaceholderText("Job name"), { target: { value: " Nightly " } });
    fireEvent.change(screen.getByPlaceholderText("Schedule (e.g. Every weekday at 9:00 AM)"), { target: { value: "0 2 * * *" } });
    fireEvent.change(screen.getByPlaceholderText("Description"), { target: { value: "Sweep" } });
    fireEvent.change(screen.getByPlaceholderText("Prompt for the agent (optional)"), { target: { value: " do it " } });
    fireEvent.click(screen.getByLabelText(/Quiet hours/));
    fireEvent.click(screen.getByLabelText(/Skip if running/));
    fireEvent.click(screen.getByLabelText(/Require explicit completion/));
    fireEvent.click(screen.getByRole("button", { name: "Create Job" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toStrictEqual({
      method: "POST",
      payload: {
        name: "Nightly",
        schedule: "0 2 * * *",
        type: "recurring",
        status: "active",
        description: "Sweep",
        action: { type: "start_session", prompt: "do it", requireExplicitCompletion: true },
        quietHours: { enabled: true, start: "22:00", end: "07:00" },
        skipIfRunning: true,
      },
    });
  });

  it("edits a job, keeping unowned action fields and sending quiet hours and skip explicitly", async () => {
    const writes = serve([savedJob]);
    render(<CronJobs agent={agent} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Daily review" }));
    fireEvent.change(screen.getByDisplayValue("Review"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByLabelText(/Quiet hours/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toStrictEqual({
      method: "PUT",
      payload: {
        name: "Daily review",
        schedule: "0 9 * * *",
        type: "recurring",
        description: "Changed",
        action: { type: "start_session", folder: "/cron-folder", maxTurns: 33, prompt: "go", provider: "codex", model: "gpt-x" },
        quietHours: { enabled: false, start: "23:00", end: "06:00" },
        skipIfRunning: false,
      },
    });
  });
});
