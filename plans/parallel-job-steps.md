# Plan: parallel job steps

Status: proposed for implementation.

This plan adds a composite `parallel` job step that can run multiple child branches concurrently. It supports two modes:

1. `race` — first successful branch wins and the remaining branches are cancelled.
2. `all` — all branches run to terminal state; the parent succeeds only if all branches succeed.

The plan was refined after an independent Claude Code review of the job runner, store, templating, and UI surfaces.

---

## Scope for v1

Implement `parallel` with **agent branches only**.

Do not support nested `parallel`, `poll`, `approval`, `wait_event`, `gate`, or `notify` branches in v1. Those require branch-level timers, event listeners, multi-approval UX, or less common synchronous semantics. Keeping v1 to `agent` branches delivers the main use case while minimizing runner risk.

---

## Schema

Example `race` step:

```jsonc
{
  "id": "compare_implementations",
  "type": "parallel",
  "mode": "race",
  "branches": [
    {
      "id": "opus",
      "type": "agent",
      "provider": "claude-code",
      "model": "opus",
      "prompt": "Solve this task: {{inputs.task}}",
      "outputs": ["answer"]
    },
    {
      "id": "sonnet",
      "type": "agent",
      "provider": "claude-code",
      "model": "sonnet",
      "prompt": "Solve this task: {{inputs.task}}",
      "outputs": ["answer"]
    }
  ],
  "next": "review",
  "onFailure": "fail"
}
```

Example `all` step:

```jsonc
{
  "id": "parallel_checks",
  "type": "parallel",
  "mode": "all",
  "branches": [
    {
      "id": "tests",
      "type": "agent",
      "prompt": "Run the test suite and report the result.",
      "outputs": ["result"]
    },
    {
      "id": "lint",
      "type": "agent",
      "prompt": "Run lint and report the result.",
      "outputs": ["result"]
    },
    {
      "id": "review",
      "type": "agent",
      "prompt": "Review the changes and report notes.",
      "outputs": ["notes"]
    }
  ],
  "next": "summarize",
  "onFailure": "fail"
}
```

All branch steps are leaf steps: they have no `next`, no branch-level `retry` in v1, and cannot reference sibling branch outputs at prompt-start time.

---

## Semantics

### `mode: "race"`

- Spawn all branches concurrently.
- The first branch that completes successfully wins.
- Failed branches are recorded, but do not win.
- When a winner is selected:
  - persist the winner result;
  - delete loser chat IDs from `chatToStep` before stopping them;
  - stop loser sessions with `stopSession`;
  - append loser history entries as cancelled/superseded;
  - append one parent aggregate history entry;
  - advance to `next`.
- If every branch fails before a winner exists, route to `onFailure` or fail.

Default race policy is `first_success`, not `first_settled`, so a fast failure cannot win the race.

### `mode: "all"`

- Spawn all branches concurrently.
- Every branch runs until terminal state.
- The parent waits until all branches are terminal.
- If all branches succeeded, append a parent aggregate history entry and advance to `next`.
- If one or more branches failed, append aggregate failure detail and route to `onFailure` or fail.

Do not fail-fast by default. A future option may add `failFast: true`, but the default should preserve the requested “wait for all” behavior.

---

## Output and history shape

Store both per-branch history and a parent aggregate history entry.

Per-branch history entries provide UI provenance, chat links, durations, and branch-specific result details:

```jsonc
{
  "stepId": "parallel_checks",
  "branchId": "tests",
  "stepType": "agent",
  "attempt": 1,
  "chatId": "...",
  "result": "completed",
  "outputs": { "result": "pass" }
}
```

The parent aggregate entry provides the stable templating surface:

```jsonc
{
  "stepId": "parallel_checks",
  "stepType": "parallel",
  "attempt": 1,
  "result": "completed",
  "outputs": {
    "tests": { "result": "pass" },
    "lint": { "result": "clean" },
    "review": { "notes": "LGTM" }
  }
}
```

For race:

```jsonc
{
  "stepId": "compare_implementations",
  "stepType": "parallel",
  "attempt": 1,
  "result": "completed",
  "outputs": {
    "_winner": "opus",
    "_winnerOutputs": { "answer": "42" },
    "opus": { "answer": "42" }
  }
}
```

Later steps can reference:

```txt
{{steps.parallel_checks.outputs.tests.result}}
{{steps.compare_implementations.outputs._winner}}
{{steps.compare_implementations.outputs._winnerOutputs.answer}}
```

Reserve output keys beginning with `_` for framework metadata. Branch IDs must not start with `_`.

---

## Shared type changes

Update `shared/types/jobs.ts`:

- Add `parallel` to `JobStepType`.
- Add `ParallelJobStep`.
- Add optional `branchId?: string` to `JobRunHistoryEntry`.
- Extend `JobRunActiveStep` with branch-aware active state.

Sketch:

```ts
export type JobStepType = "agent" | "approval" | "poll" | "wait_event" | "gate" | "notify" | "parallel";

export interface ParallelAgentBranch extends Omit<AgentJobStep, "next" | "retry"> {
  type: "agent";
}

export interface ParallelJobStep extends JobStepBase {
  type: "parallel";
  mode: "race" | "all";
  branches: ParallelAgentBranch[];
  onFailure?: string; // step id or "fail"; default "fail"
}

export interface JobRunActiveBranch {
  branchId: string;
  status: "starting" | "running" | "completed" | "failed" | "cancelled";
  attempt: number;
  startedAt: string;
  endedAt?: string;
  chatId?: string;
  pendingResult?: JobStepResult;
  outputs?: Record<string, unknown>;
  detail?: string;
}

export interface JobRunActiveStep {
  stepId: string;
  attempt: number;
  chatId?: string; // existing scalar for non-parallel steps
  startedAt: string;
  pendingResult?: JobStepResult;
  parallel?: {
    mode: "race" | "all";
    branches: Record<string, JobRunActiveBranch>;
    winnerBranchId?: string;
  };
}
```

---

## Backend implementation details

### `backend/src/services/job-runner.ts`

Add `case "parallel"` in `enterStep`.

Important: current runner internals assume a single active session. Parallel must not reuse these scalar assumptions:

- `activeStep.chatId`
- `activeStep.pendingResult`
- `chatToStep` without branch identity
- `cancelRun` stopping only one chat
- `resumeRunAfterRestart` harvesting only one chat
- `advancing` guard silently returning on concurrent completions

Refactor `JobContext`:

```ts
export interface JobContext {
  runId: string;
  stepId: string;
  branchId?: string;
  advisory?: boolean;
}
```

Add branch-aware session spawning:

- For branch sessions, pass `jobContext: { runId, stepId: parentStepId, branchId }`.
- Persist `activeStep.parallel.branches[branchId].chatId`.
- Increment `sessionsSpawned` per branch.
- Preflight `sessionsSpawned + branches.length <= maxTotalSessions` before spawning any branch.

Replace the current “drop if already advancing” pattern with a per-run queue or another non-dropping serialization mechanism. Concurrent branch completions must all be persisted and considered.

Suggested flow on branch session end:

1. Persist branch outcome durably.
2. Enqueue parent parallel resolution.
3. Under the per-run queue/lock, reload the run and evaluate whether the parent step can resolve.
4. Resolve race/all if conditions are met.

Race cancellation ordering is important:

1. Remove loser chat IDs from `chatToStep`.
2. Then call `stopSession`.
3. Then record loser cancellation/superseded history.
4. Then advance.

Update cancellation:

- `cancelRun` loops all active branch chat IDs and stops each.
- It deletes all branch chat IDs from `chatToStep` first.

Update restart recovery:

- If an active step is parallel, iterate all branch chat IDs.
- Harvest completed/stopped sessions like single-step recovery does.
- If branch state cannot be recovered cleanly, fail or retry the entire parent parallel step rather than trying partial branch restart in v1.

Retry behavior:

- `retryJobStep` on a failed `parallel` step restarts the entire parent step and all branches.
- No branch-level retry in v1.

### `backend/src/services/job-store.ts`

Update validation:

- Add `parallel` to `STEP_TYPES`.
- Add `parallel` to `stepFlowTargets`.
- Validate `onFailure` target, allowing `fail`.
- Validate each branch as an agent-like leaf step.
- Validate branch IDs:
  - unique inside the parallel step;
  - no `_` prefix;
  - no top-level step ID collision;
  - no reserved names: `_winner`, `_winnerOutputs`.
- Reject branch `next` and branch `retry` in v1.
- Reject nested `parallel` branches.
- Check branch prompt templates using the parent step’s dominance position. Branch prompts may reference inputs, run metadata, and outputs from steps guaranteed to precede the parent parallel step. They may not reference sibling branch outputs or the parent parallel step’s own outputs.

### `backend/src/services/job-step-tools.ts`

Update `complete_job_step` to record branch results when `ctx.branchId` is present.

### `backend/src/services/job-template.ts`

Ensure the parent aggregate history entry is what powers templating.

The existing `buildRunContext` can remain mostly unchanged if the parent history entry’s `outputs` already has the nested branch shape.

### `backend/src/services/job-management-tools.ts`

Update `JOB_SCHEMA_DOC` with the new `parallel` step.

Update condensed run output to include active parallel branch summaries and branch chat IDs.

### `backend/src/routes/jobs.ts`

No major endpoint changes are required, but full run JSON should expose `activeStep.parallel` for the UI.

---

## UI plan

### `frontend/src/components/JobRunPanel.tsx`

Render `parallel` as a parent row with nested branch rows.

Race example:

```txt
Compare implementations  parallel · race
  ✓ opus       completed · winner   [open chat]
  ⊘ sonnet     cancelled            [open chat]
```

All example:

```txt
Parallel checks  parallel · all · 2/3 complete
  ✓ tests       completed   [open chat]
  ✓ lint        completed   [open chat]
  ⟳ review      running     [open chat]
```

Use branch state from `activeStep.parallel.branches` while active and `history` after completion.

### `frontend/src/components/JobListItem.tsx`

Show compact parallel progress:

```txt
Step 2/5: Compare implementations (parallel race, winner: opus)
```

or:

```txt
Step 3/6: Parallel checks (parallel all, 2/3 complete)
```

### `frontend/src/pages/settings/JobsSettings.tsx`

Since the current editor is raw JSON:

- add `parallel` to help text;
- add a parallel example;
- ensure validation errors from the backend are readable for branch paths.

---

## Test plan

Add or update tests for:

1. Validation accepts basic `parallel` race/all definitions.
2. Validation rejects branch `next`, branch `retry`, duplicate branch IDs, reserved branch IDs, nested parallel, and non-agent branch types.
3. Dominator analysis allows later refs to parent aggregate outputs.
4. Branch prompt templates cannot reference sibling outputs.
5. Race winner selection cancels losers and advances once.
6. Race ignores failed branches until a success or all branches fail.
7. All mode waits for all terminal branch states before resolving.
8. Cancel stops all active branch sessions.
9. Restart recovery loops all branch chat IDs.
10. UI renders branch rows, winner badge, cancelled losers, and all-mode progress.

---

## Implementation order

1. Shared types and schema docs.
2. Validation and dominator updates.
3. Branch-aware result recording in job store/tools.
4. Runner active-state changes and non-dropping per-run completion queue.
5. Race/all resolution semantics.
6. Cancel/retry/restart behavior.
7. `get_job_run`/list summaries.
8. UI rendering.
9. Tests.
