// @vitest-environment jsdom
/**
 * UI test for JobRunPanel's parallel-step rendering (plan test item 10):
 * branch rows, the winner badge, cancelled losers, and all-mode progress.
 *
 * This is the first frontend test in the repo, so it brings a minimal setup:
 * jsdom (via the docblock above) plus @testing-library/react. The `../api`
 * module is mocked so getJobRun resolves a hand-built JobRun with no network,
 * and the component is wrapped in a MemoryRouter for its useNavigate() call.
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { JobRun } from "../api";
import JobRunPanel from "./JobRunPanel";

vi.mock("../api", () => ({
  getJobRun: vi.fn(),
  respondJobApproval: vi.fn(),
  cancelJobRun: vi.fn(),
  pauseJobRun: vi.fn(),
  resumeJobRun: vi.fn(),
  retryJobStep: vi.fn(),
}));

import { getJobRun } from "../api";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const NOW = "2026-06-16T00:00:00.000Z";

function baseRun(overrides: Partial<JobRun>): JobRun {
  return {
    runId: "run-test",
    jobId: "job-test",
    jobName: "Test Job",
    definition: {
      id: "job-test",
      name: "Test Job",
      version: 1,
      steps: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
    inputs: {},
    status: "running",
    currentStepId: null,
    loopCounts: {},
    sessionsSpawned: 0,
    history: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as JobRun;
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <JobRunPanel runId="run-test" />
    </MemoryRouter>,
  );
}

describe("JobRunPanel — parallel rendering (item 10)", () => {
  it("renders a finished race: branch rows, winner badge, and cancelled loser", async () => {
    const run = baseRun({
      status: "succeeded",
      currentStepId: null,
      sessionsSpawned: 2,
      definition: {
        id: "job-test",
        name: "Test Job",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
        steps: [
          {
            id: "compare",
            type: "parallel",
            mode: "race",
            branches: [
              { id: "opus", type: "agent", prompt: "Solve it", outputs: ["answer"] },
              { id: "sonnet", type: "agent", prompt: "Solve it", outputs: ["answer"] },
            ],
          },
        ],
      },
      history: [
        {
          stepId: "compare",
          branchId: "opus",
          stepType: "agent",
          attempt: 1,
          startedAt: NOW,
          endedAt: NOW,
          chatId: "chat-opus",
          result: "completed",
          outputs: { answer: "42" },
        },
        {
          stepId: "compare",
          branchId: "sonnet",
          stepType: "agent",
          attempt: 1,
          startedAt: NOW,
          endedAt: NOW,
          chatId: "chat-sonnet",
          result: "cancelled",
          detail: 'superseded by winning branch "opus"',
        },
        {
          stepId: "compare",
          stepType: "parallel",
          attempt: 1,
          startedAt: NOW,
          endedAt: NOW,
          result: "completed",
          outputs: { _winner: "opus", _winnerOutputs: { answer: "42" }, opus: { answer: "42" } },
        },
      ],
    });
    (getJobRun as Mock).mockResolvedValue(run);

    renderPanel();

    // Both branch rows render.
    const opusRow = (await screen.findByText("opus")).closest("div") as HTMLElement;
    const sonnetRow = screen.getByText("sonnet").closest("div") as HTMLElement;

    // The winning branch shows a "winner" badge; the loser does not.
    expect(within(opusRow).getByText("winner")).toBeDefined();
    expect(within(sonnetRow).queryByText("winner")).toBeNull();

    // The loser row shows cancelled status.
    expect(within(sonnetRow).getByText("cancelled")).toBeDefined();

    // Parent step progress summarizes the race winner.
    expect(screen.getByText("race · winner: opus")).toBeDefined();
  });

  it("renders all-mode progress and per-branch status while active", async () => {
    const run = baseRun({
      status: "running",
      currentStepId: "checks",
      sessionsSpawned: 3,
      definition: {
        id: "job-test",
        name: "Test Job",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
        steps: [
          {
            id: "checks",
            type: "parallel",
            mode: "all",
            branches: [
              { id: "tests", type: "agent", prompt: "run tests", outputs: ["r"] },
              { id: "lint", type: "agent", prompt: "run lint", outputs: ["r"] },
              { id: "review", type: "agent", prompt: "review", outputs: ["notes"] },
            ],
          },
        ],
      },
      activeStep: {
        stepId: "checks",
        attempt: 1,
        startedAt: NOW,
        parallel: {
          mode: "all",
          branches: {
            tests: { branchId: "tests", status: "completed", attempt: 1, startedAt: NOW, chatId: "c1", outputs: { r: "pass" } },
            lint: { branchId: "lint", status: "completed", attempt: 1, startedAt: NOW, chatId: "c2", outputs: { r: "clean" } },
            review: { branchId: "review", status: "running", attempt: 1, startedAt: NOW, chatId: "c3" },
          },
        },
      },
    });
    (getJobRun as Mock).mockResolvedValue(run);

    renderPanel();

    // All-mode progress badge: 2 of 3 branches terminal.
    expect(await screen.findByText("all · 2/3 complete")).toBeDefined();

    // Each branch row renders with its live status.
    const reviewRow = screen.getByText("review").closest("div") as HTMLElement;
    expect(within(reviewRow).getByText("running")).toBeDefined();
    const testsRow = screen.getByText("tests").closest("div") as HTMLElement;
    expect(within(testsRow).getByText("completed")).toBeDefined();

    // No winner badge in all-mode.
    expect(screen.queryByText("winner")).toBeNull();
  });
});
