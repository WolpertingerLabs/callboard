# Plan: jobs — deterministic multi-step agent workflows

A **job** is a reusable, named workflow definition: an ordered series of steps where the
*control flow is deterministic backend code* and the *work inside each step is done by
agents* (spawned chat sessions). Spawning a job creates a **job run** — a persisted state
machine that walks the steps, spawns sessions, waits on user signoff or external events,
loops on conditions, and notifies the user when done.

Users can create/edit/spawn/manage jobs three ways:

1. **By talking to any agent or chat session** — new callboard MCP tools (`create_job`,
   `spawn_job`, …) let an agent turn "here's a workflow I want" into a saved definition.
2. **Settings → Jobs tab** — CRUD UI for definitions + a runs dashboard.
3. **Chat view** — chats that belong to a run get a "Job" view-mode tab showing the
   stepper (current stage, attempts, links to sibling step chats, approve/reject).

Status: **Proposed.**

---

## Motivating example: "bake a Devin PR"

1. **Plan** — agent step with a specific model produces a plan document.
2. **Signoff** — run pauses, user is notified, approves/rejects/edits the plan.
3. **Issue Devin session** — agent step uses the drawlatch MCP proxy to start a Devin run,
   captures the session id as a step output.
4. **Wait** — poll every N minutes (or wake on a webhook event) until Devin reports done.
5. **Review** — agent step reviews the PR locally, or pings a reviewer via Slack.
6. **Gate + loop** — if CI is red or a review fails, send feedback to Devin and go back
   to step 4 (bounded by `maxLoops`); otherwise continue.
7. **Notify** — tell the user the PR is baked.

Every primitive above already has infrastructure in callboard; jobs compose them under a
deterministic runner instead of trusting one long-lived agent to self-orchestrate.

---

## What exists today (reused, not rebuilt)

| Need | Existing infrastructure |
| --- | --- |
| Spawn an agent session programmatically | `sendMessage()` in `backend/src/services/claude.ts`; `executeAgent()` in `agent-executor.ts` (cron/event/tool sessions, `triggeredBy` metadata) |
| Know when a child session finishes | `session-callbacks.ts` + `session-completion-handler.ts` (the `start_chat_session onComplete` path) |
| Wait on external events | `event-watcher.ts` polling drawlatch `poll_events` + `trigger-dispatcher.ts` filter/backtest/debounce |
| Timed wakeups | `cron-scheduler.ts` (node-cron) |
| Reach the user | `notify_user` / `summon_user` callboard tools |
| Session/metadata change push to UI | `session-registry.ts` + `GET /api/sessions/poll` version-delta protocol |
| File-per-entity storage | `~/.callboard/data/{chats,agents,canvas}/…` conventions via the chat/agent file services |
| Settings CRUD UI pattern | `frontend/src/pages/settings/SkillsSettings.tsx` (list + inline editor) |
| Chat view-mode toggle | `viewMode: "chat" | "diff" | "debug"` in `frontend/src/pages/Chat.tsx` |

The one genuinely new piece is the **job runner**: a persisted state machine that owns
"what happens next" so the sequence is deterministic across restarts, instead of living in
an agent's context window.

---

## Data model

Shared types go in `shared/` so frontend and backend agree.

### JobDefinition — `~/.callboard/data/jobs/definitions/{jobId}.json`

```jsonc
{
  "id": "bake-devin-pr",            // slug, unique
  "name": "Bake a Devin PR",
  "description": "Plan → signoff → Devin → review loop → notify",
  "version": 3,                      // bumped on every edit
  "inputs": [                        // parameters supplied at spawn time
    { "key": "task", "label": "Task description", "type": "text", "required": true },
    { "key": "repo", "label": "Repository", "type": "string", "default": "WolpertingerLabs/callboard" }
  ],
  "defaults": {
    "folder": "/home/cybil/callboard",   // working dir for step sessions
    "provider": "claude-code",            // per-step override allowed
    "notifyChannel": "discord"
  },
  "limits": { "maxTotalSessions": 40, "maxDurationHours": 72 },
  "steps": [ /* Step[], see below */ ],
  "createdAt": "...", "updatedAt": "...",
  "createdBy": { "kind": "chat" | "agent" | "ui", "ref": "chatId-or-alias" }
}
```

### Step types (v1 set)

Every step: `{ id, type, name?, next? }`. `next` defaults to the following step in the
array; terminal when absent on the last step. Prompts support `{{…}}` interpolation
(below).

| Type | Purpose | Key fields |
| --- | --- | --- |
| `agent` | Spawn a chat session to do work | `prompt` (template), `provider?`, `model?`, `effort?`, `folder?`, `maxTurns?`, `agentAlias?`, `outputs?` (declared keys the agent must report via `complete_job_step`), `retry?: { attempts, backoffSeconds }` |
| `approval` | Pause for user signoff | `message` (template), `notify?: boolean` (default true), `timeoutHours?`, `onReject?` (step id or `"fail"`, default fail) |
| `poll` | Re-check until a condition holds | `prompt` (a short checker prompt; the checker session calls `complete_job_step` with `verdict: "done" | "not_yet"` + outputs), `intervalMinutes`, `maxAttempts`, `onTimeout?` |
| `wait_event` | Sleep until an external event matches | `filter` (same shape as trigger filters: source/eventType/conditions), `timeoutMinutes?`, `onTimeout?` — event payload becomes the step's outputs |
| `gate` | Deterministic branch / loop-back | `condition` (see below), `onPass` (step id, default next), `onFail` (step id — looping back is how iteration works), `maxLoops` (required when `onFail` targets an earlier step) |
| `notify` | Message the user | `message` (template), `channel?`, `urgency?` |

Gate `condition` is deliberately simple and machine-evaluable — no agent in the loop:
`{ "all": [ { "ref": "steps.review.outputs.verdict", "op": "eq", "value": "pass" }, … ] }`
with ops `eq / neq / contains / exists / gt / lt`. Anything fuzzier belongs inside an
`agent` step whose job is to *emit* a clean verdict for the gate to read.

Deferred to v2: `parallel` groups, sub-jobs (`run_job` step), human-edit steps.

### Templating

`{{inputs.task}}`, `{{steps.plan.outputs.plan_md}}`, `{{run.id}}`, `{{run.loopCount.gate-ci}}`.
Plain string substitution over a flat context — implemented in ~40 lines, no library.
Unknown refs fail the step at spawn-template-time, not silently.

### JobRun — `~/.callboard/data/jobs/runs/{runId}.json`

```jsonc
{
  "runId": "run_20260611_a1b2c3",
  "jobId": "bake-devin-pr",
  "definition": { /* frozen full copy at spawn time — edits to the job never mutate in-flight runs */ },
  "inputs": { "task": "...", "repo": "..." },
  "status": "running",   // pending | running | waiting_approval | waiting_event | sleeping | paused | succeeded | failed | cancelled
  "currentStepId": "devin-poll",
  "nextWakeAt": "2026-06-11T18:40:00Z",   // for poll/sleep/timeout re-arming after restart
  "loopCounts": { "gate-ci": 2 },
  "sessionsSpawned": 9,
  "history": [
    { "stepId": "plan", "attempt": 1, "chatId": "…", "startedAt": "…", "endedAt": "…",
      "result": "completed", "outputs": { "plan_md": "…" } },
    { "stepId": "signoff", "attempt": 1, "result": "approved", "respondedVia": "ui", "comment": "ship it" }
  ],
  "error": null,
  "createdAt": "…", "updatedAt": "…", "endedAt": null
}
```

Writes are atomic (tmp file + rename), one transition at a time, persisted **before**
side effects are confirmed — the run file is the source of truth for resume.

---

## The job runner — `backend/src/services/job-runner.ts`

An event-driven state machine, one module, no new processes:

- **`spawnRun(jobId, inputs)`** — validate inputs against the definition, freeze the
  definition copy, persist the run, enter step 1.
- **Entering a step** dispatches on type:
  - `agent` / `poll` checker → spawn a session via the same path `executeAgent()` uses,
    with chat metadata `{ triggered: true, triggeredBy: "job", jobRunId, jobStepId }`.
    The session gets one extra job-scoped MCP tool, **`complete_job_step`** (only injected
    into job-step sessions): `{ outputs: object, verdict?: string, summary?: string }`.
    On session end: if the tool was called, harvest its payload; if not, fall back to
    `read_session_messages` final text as `outputs._final` and mark the step
    `completed_unstructured` (gates referencing missing keys then fail the run loudly —
    deterministic, never guessy).
  - `approval` → status `waiting_approval`, fire `notify_user` (with a deep link to the
    run) and register the pending approval. Resolution arrives from REST (UI buttons),
    or the `respond_job_approval` MCP tool (user says "approve it" to any chat).
  - `wait_event` → register an **ephemeral trigger** with the existing event-watcher
    pipeline keyed by `runId` (same filter/backtest code as `triggers.json`, but stored on
    the run, removed on match/timeout). Status `waiting_event`, `nextWakeAt` = timeout.
  - `poll` → status `sleeping` between attempts; `nextWakeAt` persisted; each wake spawns
    the checker session; `verdict: "done"` advances, `not_yet` re-sleeps, attempts
    exhausted → `onTimeout` or fail.
  - `gate` → evaluate condition over the run's context synchronously; bump
    `loopCounts[stepId]` when jumping backwards; exceeding `maxLoops` → fail with a clear
    error. No session spawned.
  - `notify` → `notify_user`, advance immediately.
- **Step completion detection** reuses the session-completion machinery: the runner
  registers interest in the step's chatId the same way `session-callbacks.ts` does for
  `onComplete`, rather than inventing a parallel watcher.
- **Restart resume** — on server boot, scan `runs/` for non-terminal runs:
  re-arm `nextWakeAt` timers, re-register ephemeral event triggers, and for steps that
  were `running`, check `get_session_status`; if the chat ended while the server was
  down, harvest output and advance. This is what makes the workflow *deterministic*
  rather than "an agent was babysitting it".
- **Safety rails** — run-level `maxTotalSessions` / `maxDurationHours`, per-step retries,
  per-gate `maxLoops`. Every transition appends to the run history; nothing is silent.
- **Control** — `pause` (finish current wait, don't enter next step), `resume`, `cancel`
  (abort in-flight step session via its AbortController), `retryStep` (re-enter
  `currentStepId` fresh).

Runner emits `job_run_updated` through the session-registry event channel so the
existing `/api/sessions/poll` version-bump protocol pushes UI updates with zero new
polling infrastructure.

---

## MCP tools (callboard-tools additions)

Registered in `backend/src/services/callboard-tools.ts` alongside the existing platform
tools, so **any chat session or agent** can manage jobs conversationally:

| Tool | Notes |
| --- | --- |
| `list_jobs` / `get_job` | Definitions, with current version |
| `create_job` | Takes the full definition JSON; tool description embeds the step-type schema + a worked example so models can author definitions reliably; server validates (unique step ids, resolvable `next`/`onPass`/`onFail` targets, `maxLoops` present on back-edges, interpolation refs resolvable) and returns precise errors for self-correction |
| `update_job` / `delete_job` | Bumps `version`; in-flight runs unaffected (frozen copy) |
| `spawn_job` | `{ jobId, inputs }` → `runId`; validates required inputs |
| `list_job_runs` / `get_job_run` | Status, current step, history summary |
| `cancel_job_run` / `pause_job_run` / `resume_job_run` | |
| `respond_job_approval` | `{ runId, decision: "approve" | "reject", comment? }` — lets the user sign off from any chat |
| `complete_job_step` | **Only injected into job-step sessions** (keyed off `jobRunId` metadata); reports structured outputs/verdict for the current step |

This directly enables the target UX: user describes the workflow in chat → agent calls
`create_job` → user later says "spawn it" (or uses the UI) → `spawn_job`.

## REST API — `backend/src/routes/jobs.ts`

Thin wrappers over the same store/runner functions the MCP tools use:

- `GET/POST /api/jobs`, `GET/PUT/DELETE /api/jobs/:id`
- `POST /api/jobs/:id/spawn` → `{ runId }`
- `GET /api/jobs/runs?status=…&jobId=…`, `GET /api/jobs/runs/:runId`
- `POST /api/jobs/runs/:runId/(cancel|pause|resume|retry-step)`
- `POST /api/jobs/runs/:runId/approval` `{ decision, comment? }`

---

## Frontend

### Settings → Jobs tab

Add `{ key: "jobs", label: "Jobs", icon: Workflow }` to the `tabs` array in
`frontend/src/pages/Settings.tsx`; new `frontend/src/pages/settings/JobsSettings.tsx`
following the SkillsSettings list-plus-inline-editor pattern. Two sections:

1. **Definitions** — card list; editor with name/description/inputs fields and a step
   list (one card per step: type selector + type-specific fields, drag-reorder), plus a
   **raw JSON toggle** as the escape hatch — agents author JSON, and the form editor only
   needs to cover the common cases in v1.
2. **Runs** — table of runs (job, status badge, current step, started, last update) with
   Spawn / Pause / Cancel / Approve actions and an expandable per-run timeline rendered
   from `history`. Refreshes off the SessionContext metadata version bump.

### Chat view integration

- Step chats are ordinary chats tagged `jobRunId`/`jobStepId` in metadata, so they appear
  in the chat list as usual. Add a **job badge** in `ChatListItem.tsx` (like the existing
  triggered/agent badges) and include job chats under the existing triggered-chats filter
  semantics.
- In `Chat.tsx`, when the open chat's metadata has `jobRunId`, extend the view-mode
  toggle to `"chat" | "diff" | "debug" | "job"`. The **Job tab** shows: job name, a
  vertical stepper of all steps (done / current / pending, loop counts, attempt numbers),
  links to each step's chat, frozen inputs, and Approve/Reject buttons when the run is
  `waiting_approval`. One component (`components/JobRunPanel.tsx`) shared between this tab
  and the runs table expansion in settings.

No dedicated top-level jobs page in v1 — settings tab + chat tab covers create/manage and
monitor; a sidebar view can come later if runs become numerous.

---

## Worked example as stored definition

```jsonc
{
  "id": "bake-devin-pr",
  "name": "Bake a Devin PR",
  "inputs": [{ "key": "task", "type": "text", "required": true }],
  "steps": [
    { "id": "plan", "type": "agent", "model": "claude-opus-4-8",
      "prompt": "Write an implementation plan for: {{inputs.task}}. Call complete_job_step with outputs.plan_md when done.",
      "outputs": ["plan_md"] },
    { "id": "signoff", "type": "approval",
      "message": "Plan ready for {{inputs.task}}:\n\n{{steps.plan.outputs.plan_md}}",
      "onReject": "fail" },
    { "id": "issue-devin", "type": "agent",
      "prompt": "Start a Devin session via the drawlatch proxy for this plan: {{steps.plan.outputs.plan_md}}. Report outputs.devin_session_id and outputs.pr_url when the session is created.",
      "outputs": ["devin_session_id", "pr_url"] },
    { "id": "await-devin", "type": "poll", "intervalMinutes": 15, "maxAttempts": 96,
      "prompt": "Check Devin session {{steps.issue-devin.outputs.devin_session_id}} via the proxy. Verdict 'done' when the session is finished, else 'not_yet'." },
    { "id": "review", "type": "agent",
      "prompt": "Review PR {{steps.issue-devin.outputs.pr_url}}: check CI status and code quality. Report outputs.verdict = 'pass' or 'fail' and outputs.feedback.",
      "outputs": ["verdict", "feedback"] },
    { "id": "ci-gate", "type": "gate", "maxLoops": 5,
      "condition": { "all": [{ "ref": "steps.review.outputs.verdict", "op": "eq", "value": "pass" }] },
      "onPass": "done", "onFail": "send-feedback" },
    { "id": "send-feedback", "type": "agent", "next": "await-devin",
      "prompt": "Send this feedback to Devin session {{steps.issue-devin.outputs.devin_session_id}}: {{steps.review.outputs.feedback}}" },
    { "id": "done", "type": "notify",
      "message": "PR is baked and ready: {{steps.issue-devin.outputs.pr_url}}" }
  ]
}
```

---

## Implementation phases

**Phase 1 — core engine + conversational CRUD (the spine)**
Shared types; job store (`job-file-service.ts`); runner with `agent`, `approval`,
`notify`, `gate` steps (sequential + back-edges + maxLoops); `complete_job_step` capture
with unstructured fallback; MCP tools (full CRUD + spawn/status/approve); REST routes;
chat metadata tagging. *Deliverable: the Devin job minus poll/wait_event can be created
from chat and run end-to-end.*

**Phase 2 — time and events**
`poll` and `wait_event` steps; `nextWakeAt` persistence; ephemeral triggers through
event-watcher; full restart-resume (re-arm timers/waits, harvest sessions that finished
while down); run safety limits.

**Phase 3 — UI**
Settings Jobs tab (definitions CRUD with raw-JSON toggle, runs table + timeline); Job
view-mode tab in Chat.tsx via shared `JobRunPanel`; job badge in ChatListItem; approval
buttons + notify deep links.

**Phase 4 (later) — power features**
Parallel step groups; `run_job` sub-job step; cron-spawned jobs (a cron action that calls
`spawn_job`); job definition export/import (shareable JSON, pairs with custom skills);
per-step cost/budget tracking surfaced in the run timeline.

---

## Design decisions & rejected alternatives

- **Backend state machine, not an orchestrator agent.** An agent babysitting a multi-day
  workflow burns tokens, drifts, and dies on restart. The runner owns control flow;
  agents own judgment inside steps. (The existing `start_chat_session` + `onComplete`
  pattern stays for ad-hoc agent-driven workflows — jobs are the deterministic tier.)
- **Frozen definition per run.** Editing a job mid-run must never change in-flight
  behavior; reproducibility beats hot-patching. Re-spawn to pick up edits.
- **Machine-evaluable gates only.** Fuzzy judgment ("is this review good enough?") lives
  in agent steps that emit clean verdicts; gates just compare values. This keeps the
  loop-or-continue decision auditable.
- **Steps are ordinary chats.** Full transcript visibility, existing permissions model,
  existing chat UI — no shadow execution surface.
- **No new polling channel.** Run updates ride the existing session-registry version-bump
  protocol.
- **JSON-first definitions, form-second.** Agents are the primary authors (per the target
  UX); the settings form is a convenience layer over the same validated JSON.
