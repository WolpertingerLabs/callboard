import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Triggers from "./Triggers";
import CronJobs from "./CronJobs";
import { resetSystemInfoCache } from "../../../api";
import type { AgentConfig, Trigger, CronJob } from "../../../api";

const agent = { alias: "test-agent", workspacePath: "/project" } as AgentConfig;
const savedTrigger: Trigger = {
  id: "trigger-1",
  name: "Review event",
  description: "Original",
  status: "active",
  filter: {},
  triggerCount: 0,
  action: { type: "start_session", provider: "codex", model: "gpt-6-astra", effort: "ultra", folder: "/special", maxTurns: 37 },
};
const savedJob: CronJob = {
  id: "job-1",
  name: "Daily review",
  description: "Review",
  status: "active",
  type: "recurring",
  schedule: "0 9 * * *",
  action: { type: "start_session", provider: "cline", model: "openai/example", effort: "high", folder: "/cron-folder", maxTurns: 33 },
};
function serve({ triggers = [] as Trigger[], jobs = [] as CronJob[], reject = false } = {}) {
  const writes: Array<{ method: string; payload: { action: Record<string, unknown> } }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = { models: [], aliases: [] };
    let ok = true;
    if (init?.method === "PUT" || init?.method === "POST") {
      const payload = JSON.parse(String(init.body));
      writes.push({ method: init.method, payload });
      body = reject ? { error: "Effort ultra is unsupported for this model" } : { trigger: { ...savedTrigger, ...payload }, job: { ...savedJob, ...payload } };
      ok = !reject;
    } else if (url.includes("/system-info")) body = { codexConfigured: true, clineProviderId: "openrouter" };
    else if (url.includes("/codex/reasoning")) {
      const query = new URL(url, "http://localhost").searchParams;
      body = {
        provider: query.get("provider"),
        route: query.get("provider") === "cline" ? "openrouter" : "native",
        efforts: ["low", "high", "max", "ultra"],
        status: "known",
      };
    } else if (url.endsWith("/triggers")) body = { triggers };
    else if (url.endsWith("/cron-jobs")) body = { jobs };
    return { ok, status: ok ? 200 : 400, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { writes, fetchMock };
}
beforeEach(() => {
  resetSystemInfoCache();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function selectEffort(effort: string) {
  await screen.findByRole("option", { name: effort });
  fireEvent.change(screen.getByLabelText("Reasoning effort"), { target: { value: effort } });
}

describe("automation model-aware reasoning payloads", () => {
  it("creates a Codex trigger with max/ultra and the actual execution folder", async () => {
    const { writes, fetchMock } = serve();
    render(<Triggers agent={agent} />);
    fireEvent.click(await screen.findByRole("button", { name: "New Trigger" }));
    fireEvent.change(screen.getByPlaceholderText("Trigger name"), { target: { value: "New event" } });
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-6-astra" } });
    await selectEffort("ultra");
    fireEvent.click(screen.getByRole("button", { name: "Create Trigger" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].payload.action).toMatchObject({ provider: "codex", model: "gpt-6-astra", effort: "ultra" });
    expect(fetchMock).toHaveBeenCalledWith("/api/codex/reasoning?provider=codex&model=gpt-6-astra&cwd=%2Fproject", expect.anything());
  });

  it("edits a trigger without losing unowned or future action fields and explicitly clears effort", async () => {
    const trigger = { ...savedTrigger, action: { ...savedTrigger.action, futureField: { retained: true } } };
    const { writes, fetchMock } = serve({ triggers: [trigger] });
    render(<Triggers agent={agent} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("option", { name: "ultra" });
    fireEvent.click(screen.getByRole("button", { name: "Clear effort" }));
    fireEvent.change(screen.getByPlaceholderText("Description (optional)"), { target: { value: "Changed description" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].payload.action).toMatchObject({
      type: "start_session",
      provider: "codex",
      model: "gpt-6-astra",
      folder: "/special",
      maxTurns: 37,
      futureField: { retained: true },
    });
    expect(writes[0].payload.action).not.toHaveProperty("effort");
    expect(fetchMock).toHaveBeenCalledWith("/api/codex/reasoning?provider=codex&model=gpt-6-astra&cwd=%2Fproject", expect.anything());
  });

  it("preserves saved effort and action type when only a trigger description changes", async () => {
    const trigger = { ...savedTrigger, action: { ...savedTrigger.action, type: "send_message" as const } };
    const { writes } = serve({ triggers: [trigger] });
    render(<Triggers agent={agent} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("option", { name: "ultra" });
    fireEvent.change(screen.getByPlaceholderText("Description (optional)"), { target: { value: "Description only" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].payload.action).toMatchObject(trigger.action);
  });

  it("displays server validation errors without closing or dropping the trigger configuration", async () => {
    const { writes } = serve({ triggers: [savedTrigger], reject: true });
    render(<Triggers agent={agent} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("option", { name: "ultra" });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect((await screen.findByRole("alert")).textContent).toContain("Effort ultra is unsupported");
    expect((screen.getByLabelText("Reasoning effort") as HTMLSelectElement).value).toBe("ultra");
  });

  it("uses the configured Cline catalog for cron create and serializes the provider/model/effort", async () => {
    const { writes, fetchMock } = serve();
    render(<CronJobs agent={agent} />);
    fireEvent.click(await screen.findByRole("button", { name: "New Job" }));
    fireEvent.change(screen.getByPlaceholderText("Job name"), { target: { value: "New job" } });
    fireEvent.change(screen.getByPlaceholderText("Schedule (e.g. Every weekday at 9:00 AM)"), { target: { value: "0 9 * * *" } });
    fireEvent.change(screen.getByPlaceholderText("Description"), { target: { value: "Review" } });
    fireEvent.click(screen.getByRole("button", { name: "Cline" }));
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "openai/example" } });
    await selectEffort("high");
    fireEvent.click(screen.getByRole("button", { name: "Create Job" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].payload.action).toMatchObject({ provider: "cline", model: "openai/example", effort: "high" });
    expect(fetchMock).toHaveBeenCalledWith("/api/cline/models?providerId=openrouter", expect.anything());
  });

  it("uses the configured Cline catalog in cron edit and clears its saved effort", async () => {
    const { writes, fetchMock } = serve({ jobs: [savedJob] });
    render(<CronJobs agent={agent} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Daily review" }));
    await screen.findByRole("option", { name: "high" });
    fireEvent.click(screen.getByRole("button", { name: "Clear effort" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].payload.action).toMatchObject({ provider: "cline", model: "openai/example", folder: "/cron-folder", maxTurns: 33 });
    expect(writes[0].payload.action).not.toHaveProperty("effort");
    expect(fetchMock).toHaveBeenCalledWith("/api/cline/models?providerId=openrouter", expect.anything());
  });
});
