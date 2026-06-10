# Plan: Per-generation rows in the Responses table for OpenRouter

The chat view's **Debug / Responses** tab (`frontend/src/components/ChatDebugPanel.tsx`)
renders one row per API generation for Claude Code sessions but collapses an
entire OpenRouter *user turn* into a single row. This plan explains why, and
how to fix it so each individual OpenRouter generation (model call) is listed.

Status: **Researched, not started.**

---

## How the Responses table works today

`ChatDebugPanel` receives the full `ParsedMessage[]` for a chat (the same array
the conversation view renders) and builds its table in `allRows` (a `useMemo`):

1. **Collect** every `m.role === "assistant"` message that carries `m.usage`.
2. **Group by `requestId`**, preserving first-seen order. Messages with no
   `requestId` each become their own group (`__ungrouped_N`).
3. **Pick a canonical entry per group** — prefer the entry whose `stopReason`
   is set (the final streamed block which carries the true `output_tokens`
   total), else the last entry in the group.
4. **Recompute inter-row timing deltas** (`deltaMs`, `msPerOutputToken`)
   between consecutive canonical entries.

Each resulting row = one group = one `requestId`. The table then offers
sortable columns (In/Out/Cache R/Cache W/Delta/ms·tok) plus model / stop / tier
/ geo / req-id, and an aggregate stats header (`{count} responses`, totals,
avg/p95 delta, cache-hit rate).

### Why grouping by `requestId` is correct for Claude Code

In the Claude Code session JSONL each *physical API response* gets a distinct
`requestId` (`backend/src/agents/adapters/claude-code/sessionParser.ts:195`
reads `msg.requestId` straight off each JSONL line). One API response can still
fan out into several `ParsedMessage`s — a `thinking` block, a `text` block, and
one or more `tool_use` blocks all share that single `requestId`. Grouping by
`requestId` therefore re-collapses those blocks back into the one API
generation they came from. **1 `requestId` == 1 generation.** Correct.

---

## Why OpenRouter shows one row per *message sent* instead of per generation

The OpenRouter adapter has a different `requestId` granularity. Two parsers can
feed `ParsedMessage`s for OR sessions:

- **`transcriptParser.ts`** (preferred) — reads `transcript.jsonl`.
- **`sessionParser.ts`** (fallback) — reads `state.json` + the `req_*/gen_*`
  tree, for legacy / `persistSession:false` sessions.

`OpenRouterSessionProvider.parseSessionMessages` tries the transcript first and
falls back to the state tree.

In **both** parsers, `requestId` is the **per-user-cycle request id, not the
per-generation id**:

- In the harness (`@wolpertingerlabs/openrouter-agent-harness/dist/agent.js`),
  one `cycleRequestId = createRequestId()` is minted **per user input cycle**
  (the outer `while(true)` loop, line ~1129). The comment is explicit:
  *"Per-cycle request id … one id per cycle keeps `logs/<session>/req_*/`
  directories in 1:1 correspondence with the wire calls."* But that same
  `cycleRequestId` is then stamped on **every** `logTranscriptAssistant`
  (`response.completed` fires once per SDK turn — initial response *and* every
  tool-driven follow-up, line ~1295) and **every** `logGeneration`
  (`onTurnEnd` per follow-up + the final `getResponse`, lines ~1167/1399).
- So a single OR user turn that does N tool round-trips produces **N+1
  generations all sharing one `requestId`** — each a real, separately-billed
  model call with its own usage/cost/duration.
- `transcriptParser.ts:applyAssistantMeta` copies that shared `requestId` onto
  each assistant `ParsedMessage`; `sessionParser.ts` does the same but worse —
  it reads only the *latest* `gen_*/response.json` per `req_*` dir
  (`readLatestResponseMeta`) and applies that single meta to the whole turn,
  literally discarding intermediate generations.

When `ChatDebugPanel` then groups by `requestId`, all N+1 generations of a turn
collapse into **one row**, and the canonical-entry pick keeps only the final
one. Net effect: **one row per user message sent**, exactly the reported bug.

The richer signal already exists in the transcript: each `assistant` record is
one generation and carries its own `turnNumber`, `usage`, `costUsd`,
`durationMs`, and `model`. We are throwing that granularity away at grouping
time.

---

## Goal

In the Responses table, for OpenRouter sessions, render **one row per
generation** (per `response.completed` / per assistant transcript record),
while keeping Claude Code behavior byte-for-byte unchanged.

---

## Design

The cleanest fix keeps the frontend grouping logic provider-agnostic and gives
it a key that is already per-generation. Two coordinated changes:

### 1. Carry a per-generation identity through `ParsedMessage`

Add an optional field to `shared/types/message.ts`:

```ts
/** Monotonic turn index within an OpenRouter session (one per generation /
 *  model call). Distinct from `requestId`, which OR shares across all
 *  generations of a single user-input cycle. Used by the Responses table to
 *  list each generation as its own row. */
generationIndex?: number;
```

(Name TBD — `generationIndex` reads clearly against the existing `requestId`.
`turnNumber` mirrors the transcript field name but is OR-internal jargon.)

### 2. Populate it in the OpenRouter parsers

- **`transcriptParser.ts`** — `translateAssistantRecord` already gets the whole
  record; thread `rec.turnNumber` through `applyAssistantMeta` and set
  `m.generationIndex`. Because each assistant transcript record is exactly one
  generation, a simple **running counter incremented per assistant record**
  (independent of `turnNumber`, which can repeat / reset across follow-ups in
  edge cases) is the most robust source. Prefer a parser-local counter over
  trusting `turnNumber` to be globally unique.
- **`sessionParser.ts`** (fallback path) — currently reads only the latest
  `gen_*` per `req_*`. To list every generation here too, iterate **all**
  `gen_*/response.json` files (sorted by mtime) instead of just the newest, and
  emit one decorated assistant message per generation, each with an incrementing
  `generationIndex`. This is a deeper change; since the transcript path is the
  default and the state-tree path is legacy/fallback, we can land the
  transcript fix first and treat the fallback as a follow-up (documented as a
  known limitation in the interim — the fallback keeps today's one-row-per-turn
  behavior).

### 3. Group by the new key in `ChatDebugPanel`, falling back to `requestId`

Change the grouping key in `allRows`:

```ts
const key =
  m.generationIndex != null
    ? `gen_${m.generationIndex}`
    : m.requestId || `__ungrouped_${ungroupedIdx++}`;
```

This is fully backward compatible:

- Claude Code messages never set `generationIndex`, so they keep grouping by
  `requestId` (1 row per generation, unchanged).
- OpenRouter messages set `generationIndex`, so each generation becomes its own
  group → its own row.

The canonical-entry pick, delta recomputation, sorting, filtering, and stats
header all continue to work unchanged — they operate on groups, and we have
simply made the groups finer-grained for OR.

### 4. Display considerations

- The **Req ID** column will repeat across the rows of one OR turn (they share
  a `requestId`). That is acceptable and arguably useful (it shows which
  generations belong to the same user turn). Optionally add a subtle visual
  grouping (e.g. only show the req-id on the first row of a run) — a nice-to-have,
  not required for the fix.
- `costUsd` and `durationMs` already live per-message and will now surface
  per-generation; consider adding a **Cost** and/or **Duration** column to the
  table since OR uniquely provides them (Claude rows would show `-`). Optional,
  scoped as a follow-up enhancement.

---

## Files to touch

| File | Change |
|------|--------|
| `shared/types/message.ts` | Add `generationIndex?: number`. |
| `backend/src/agents/adapters/openrouter/transcriptParser.ts` | Maintain a per-assistant-record counter; set `generationIndex` in `applyAssistantMeta` / `translateAssistantRecord`. |
| `backend/src/agents/adapters/openrouter/sessionParser.ts` | (Follow-up) Emit one assistant message per `gen_*`, each with `generationIndex`. |
| `frontend/src/components/ChatDebugPanel.tsx` | Group by `generationIndex` when present, else `requestId`. |
| `backend/src/agents/adapters/openrouter/transcriptParser.test.ts` | Assert `generationIndex` increments per assistant record and is absent for non-OR. |
| (new/extended) frontend test if one exists for the panel | Assert OR messages produce N rows for an N-generation turn. |

---

## Test plan

1. **Unit (backend):** a transcript with one user turn + two assistant records
   (tool round-trip then final) yields two assistant `ParsedMessage`s with
   `generationIndex` 0 and 1 and the *same* `requestId`.
2. **Unit (frontend grouping):** feed the panel a mixed array; assert OR turns
   expand to per-generation rows while a synthetic Claude block (shared
   `requestId`, no `generationIndex`) still collapses to one row.
3. **Manual:** run an OR chat that uses tools across several model calls in one
   user message; open Debug tab; confirm one row per model call, correct
   per-row tokens/cost/delta, and that the `{count} responses` header now
   matches the true generation count.
4. **Regression:** open an existing Claude Code chat's Debug tab; confirm row
   count, deltas, and stats are identical to before.

---

## Open questions

- **Field name:** `generationIndex` vs `turnNumber` vs `generationId`. Index is
  enough for grouping; a stable id (the OR `generationId` from the `gen_*` dir /
  the SDK response id) would be more robust if the SDK ever exposes it on the
  transcript record — it currently does not, so a parser-local counter is the
  pragmatic choice.
- **Fallback parser scope:** land transcript-only first (covers all current
  sessions) and follow up on `sessionParser.ts`, or do both at once? Recommend
  splitting for a smaller, safer first PR.
- **Extra columns (Cost / Duration):** include in this PR or a follow-up?
