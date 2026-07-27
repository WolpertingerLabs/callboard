# Plan: idempotent execution IDs for job spawn recovery

Replace the job runner's scan-and-guess crash recovery with a deterministic **execution
key** written *before* every spawn, so restart reconciliation is an exact lookup instead of
a filesystem sweep plus a "newest unharvested wins" heuristic.

Status: **Proposed.** Pattern observed in getpaseo/paseo's Hub design (AGPLv3) —
architecture only, no code reuse.

---

## The pattern being borrowed

From paseo's `docs/hub.md`:

> Each Hub create carries an execution ID. The daemon stores that ID with the agent's
> relationship owner **before acknowledging creation**. Duplicate or replayed creates for
> the same daemon and execution resolve to the same durable agent. After a lost response,
> reconnect, or daemon restart, the Hub retries `hub.execution.agent.create.request` with
> the same execution ID. The idempotent response returns the existing agent and its current
> state; **there is no separate reconciliation RPC.**

That last clause is the whole point. Paseo has no orphan-adoption code because the identity
is deterministic, so "did I already spawn this?" is a lookup, not an inference.

---

## What callboard does today

`backend/src/services/job-runner.ts` spawns children and then persists the linkage:

```ts
// startSubJobStep, ~line 565
child = spawnJobRun(step.jobId, childInputs, { parentRunId: run.runId, parentStepId: step.id, depth: depth + 1 }, { cardId: run.cardId });
...
run.activeStep = { stepId: step.id, attempt: 1, startedAt: …, childRunId: child.runId };
run.status = "waiting_child";
saveRun(run);
```

There is a window between `spawnJobRun` returning and `saveRun` landing. A crash inside it
leaves a child on disk that the parent has no record of. The recovery path
(`adoptOrphanChildRun`, ~line 685) handles it like this:

```ts
const harvested = new Set(run.history.filter((h) => h.stepId === step.id && h.childRunId).map((h) => h.childRunId!));
const orphan = findChildRun(run.runId, step.id, harvested);
```

and `findChildRun` in `job-store.ts:433`:

```ts
for (const file of readdirSync(runsDir).filter((f) => f.endsWith(".json"))) {
  const run: JobRun = JSON.parse(readFileSync(join(runsDir, file), "utf8"));
  if (run.parentRunId !== parentRunId || run.parentStepId !== parentStepId || exclude.has(run.runId)) continue;
  if (!newest || run.createdAt > newest.createdAt) newest = run;
}
```

Three problems:

1. **O(all runs) full read on every adoption.** Every run JSON on disk is parsed to find
   one child. This scales with total historical runs, not with the run in question.
2. **The key is incomplete.** `(parentRunId, parentStepId)` does not include `attempt`. A
   step reached twice — a retry, or a backward jump via `onFailure` — produces two
   legitimate children with the same key, disambiguated only by "newest not in `history`".
   If the crash window straddles a retry, the wrong child can be adopted, and its outputs
   get attributed to the wrong attempt.
3. **Agent steps have no equivalent at all.** The `running` restart branch (~line 160)
   fails hard when the session id was never persisted:
   ```ts
   if ((branch.status === "running" || branch.status === "starting") && !branch.chatId) unrecoverable = true;
   ...
   if (unrecoverable) failRun(run, `Parallel step "…" could not recover one or more branch sessions after restart`);
   ```
   A crash between spawning a chat session and writing its `chatId` kills the whole run. The
   session is still on disk; nothing can find it.

---

## Design

### The key

```ts
/** Deterministic identity of one spawn attempt at one step of one run. */
type ExecutionKey = string;  // `${runId}:${stepId}:${n}` (+ `:${branchId}` for parallel)

function executionKey(runId: string, stepId: string, n: number, branchId?: string): ExecutionKey {
  return branchId ? `${runId}:${stepId}:${n}:${branchId}` : `${runId}:${stepId}:${n}`;
}
```

Human-readable on purpose — it shows up in logs and makes crash forensics trivial. Not
hashed; there is no adversary and no length problem.

> **Corrected 2026-07-27 (architect ruling).** The third segment was originally specified as
> `attempt`. **That is wrong and would have shipped the bug it was meant to fix.**
> `enterStep` (`job-runner.ts:496`) unconditionally sets `attempt: 1` on every entry, so a
> step re-entered via an `onFailure` target or a backward jump produces `attempt: 1` twice —
> two distinct spawns colliding on one identity, exactly the case the headline test exists to
> catch. Redefining `attempt` to increment across re-entries is also unavailable: it doubles
> as the retry budget (`attempt < step.retry.attempts`), so a loop re-entry would silently
> consume retries.
>
> `n` is therefore a **monotonic per-`(run, stepId)` spawn counter** (`JobRun.executionCounts`),
> incremented on every attempt start — first entry, retry, and loop re-entry alike. It is
> written in the same `saveRun` as the intent, so it survives restart. With no loops it equals
> `attempt`. `activeStep.attempt` semantics are untouched.
>
> This supersedes Open Question 2 below, which turned out to be load-bearing rather than
> optional. A crash between minting and the intent write is benign: nothing was spawned, so
> re-minting the same ordinal is correct. Recovery of a key that resolves to nothing re-enters
> the step and mints a *fresh* ordinal rather than reusing the abandoned one, which keeps
> "one key, at most one spawn" strictly true.

### Write intent before spawning

The ordering inverts. Today: spawn → persist. New: persist intent → spawn → persist result.

```ts
run.activeStep = { stepId: step.id, attempt, startedAt, executionKey: key };
run.status = "waiting_child";
saveRun(run);                       // intent is durable BEFORE anything is spawned
const child = spawnJobRun(…, { executionKey: key, … });
run.activeStep.childRunId = child.runId;
saveRun(run);                       // linkage; loss of THIS write is now recoverable
```

The child carries `executionKey` in its own persisted record. Recovery becomes:

```ts
const existing = findRunByExecutionKey(run.activeStep.executionKey);
if (existing) adopt(existing); else spawn();
```

No scan, no heuristic, no ambiguity across attempts.

### Index, not scan

`job-store.ts` gains a small index — `runs/by-execution-key.json`, or a lazily-built
in-memory `Map<ExecutionKey, runId>` populated during the boot pass that already reads every
run (`listResumableRuns`). Given the runner already walks the runs dir at startup, the
in-memory map is close to free and avoids a second write path that can itself get torn.

**Recommendation: in-memory map built at boot, rebuilt on write.** No new file, no new
consistency problem. `findChildRun` and its full-directory read are deleted.

### Extend to agent steps and parallel branches

Same key, same ordering, applied to chat sessions:

- Write `activeStep.executionKey` (and `parallel.branches[i].executionKey`) before calling
  the chat-creation path.
- Stamp the key into chat metadata at creation.
- On restart with a missing `chatId`, look up the chat by execution key rather than
  declaring the run unrecoverable.

This is the change that actually removes a failure mode users can hit, as opposed to
optimizing one they rarely do. Chat metadata is already a free-form JSON string
(`Chat.metadata`), so this needs no schema migration on the chat side.

### Idempotent spawn

`spawnJobRun` accepts an optional `executionKey`. If a run with that key already exists in a
non-terminal state, it **returns that run** instead of creating a second one. This makes the
whole path safe to call twice, which in turn makes retry-on-error safe in a way it currently
isn't.

---

## Migration

`executionKey` is optional on `JobRun` and `activeStep`. Runs persisted before this change
have none:

- Recovery tries key lookup first.
- If `activeStep.executionKey` is absent, fall back to the existing `findChildRun` path
  **for one release**, then delete it.
- No data migration, no rewrite of historical runs.

---

## Tests

- Crash between intent-write and spawn → recovery spawns exactly once.
- Crash between spawn and linkage-write → recovery adopts the existing child, does not
  duplicate.
- **Step retried after failure, crash in the second attempt's window** → adopts attempt 2's
  child, not attempt 1's. (This is the case today's heuristic can get wrong; it is the
  headline test.)
- Parallel step, crash after two of three branches spawned → the two are adopted, the third
  is spawned.
- Agent step, crash before `chatId` persisted → session recovered by key instead of
  `failRun`.
- `spawnJobRun` called twice with the same key → one run.
- Legacy run without `executionKey` → falls back cleanly.

---

## Non-goals

- Distributed/multi-process job execution. The key would support it; the runner is
  single-process and stays that way here.
- Idempotency for anything outside the job runner (cron spawns, event triggers). Same
  pattern would apply, but each is its own scope.
- Exactly-once *side effects* inside a step. This gives exactly-once **spawn**; an agent
  that already pushed a commit before the crash still pushed it.

## Risks

- **Ordering discipline.** The correctness argument depends entirely on intent being durable
  before the spawn. Any future code path that spawns first re-opens the hole. Worth a
  comment block at the spawn site and an assertion in dev.
- **Extra `saveRun` per step entry.** One additional small JSON write on the hot path.
  Negligible at our run volumes; measure if runs get big.
- **Key collision on manual re-run.** If a run is ever restarted in place reusing `runId`,
  keys collide. Currently re-runs get new run ids — confirm that stays true.

## Open questions

1. Should the execution key be exposed in the run API / jobs UI? Useful for debugging;
   trivially cheap; slight surface-area cost.
2. ~~Do we want `attempt` to increment on backward jumps, or is that a separate counter?~~
   **Resolved 2026-07-27 — separate counter.** See the correction under "The key". This was
   not optional: `attempt` cannot carry identity. Left here because the question being asked
   at spec time is what caught it at implementation time.
