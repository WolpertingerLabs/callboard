# OpenRouter live chat: discrete per-item messages — harness gap analysis

**Status:** investigation only. No callboard-only fix exists. Awaiting owner decision.

## Goal (spec, verbatim)

> Every single individual worker assistant message or tool call or thinking or any
> other type of message, and every single coordinator message needs to be preserved,
> relayed, and output one after another. We do not combine messages. We do not alter
> them. We only emit them, record them, and return them in successive calls.

End goal: in the callboard **live** chat UI, a stock OpenRouter-harness user sees the
full orchestration transcript — every coordinator message, every worker message, every
worker reasoning/thinking block, every tool call — as **discrete, successive, verbatim**
chat messages. Nothing combined, nothing altered (no injected separators, no trimming).

## Why the earlier `\n\n`-separator approach was wrong

It violated the spec twice: it still **combined** the items into a single bubble/text
stream, and it **altered** content by injecting characters the model never produced. It
has been reverted (branch reset to `main`).

## Ground truth: the live path cannot do this in callboard alone

callboard's only live consumption path is `translateOpenRouterEvents`, which iterates the
harness run and consumes the harness `AgentCoreEvent` union — nothing lower.

- Sole consumer: `backend/src/agents/adapters/openrouter/messageAdapter.ts:52`
  (`for await (const event of run)`), called once from
  `backend/src/agents/adapters/openrouter/OpenRouterAdapter.ts:100`.

### The harness flattens `message` and `reasoning` output items into boundary-less deltas

In `@wolpertingerlabs/openrouter-agent-harness@0.3.0` (`dist/`):

- `text_delta` / `reasoning_delta` carry only `content: string` — **no item id, index, or
  phase** (`events.d.ts:12-13`, `events.d.ts:28-29`).
- Harness run loop over the raw SSE stream (`agent.js:1417`):
  - `response.output_text.delta → text_delta` (`agent.js:1476`)
  - `response.reasoning_text.delta → reasoning_delta` (`agent.js:1491`)
  - `response.output_item.done` (`agent.js:1566`) yields **only** for `function_call`
    (`agent.js:1570`) and server tools (`agent.js:1588`); **`message` and `reasoning`
    items fall through to `continue` (`agent.js:1622`) with no yield.**
  - There is **no** `response.output_item.added` handler at all.
- `HookEvent` (`events.d.ts:101`) has no per-output-item event, and `onHook` is audit-only
  (cannot interleave messages into the live stream).

### The boundary info exists one layer down — and is discarded before callboard sees it

- `@openrouter/agent`'s `getFullResponsesStream()` yields raw SSE events verbatim
  (`esm/lib/model-result.js:1577`, `:1584`), so the harness **does** receive
  `response.output_item.added/.done`.
- Those items carry `id` and a `phase` of `commentary` (intermediate assistant message)
  vs `final_answer` (`@openrouter/sdk` `esm/models/outputmessage.d.ts`) — exactly the
  coordinator-vs-final distinction the spec needs; `output_item.added` also carries
  `outputIndex` (`esm/models/streameventsresponseoutputitemadded.d.ts`).
- `@openrouter/agent` even ships `buildMessageStreamCore`
  (`esm/lib/stream-transformers.js:45`) which resets accumulated text on every
  `output_item.added` and yields per-message `complete` items — but **the harness does not
  use it** for the event stream callboard consumes.

So tool / server-tool items already arrive **discrete and in order**, but **consecutive
`message` items and `reasoning` items have no live boundary signal** callboard can key off.
Two adjacent message items (e.g. coordinator `commentary` immediately followed by
`final_answer`) are indistinguishable from one message's continuing deltas.

## Why the stored path "looks right" (with a correction to the brief)

- `sessionParser.ts` (the **state.json fallback**) splits correctly because it reads the
  SDK's persisted `state.messages[]`, where each output item is a *separate array entry* —
  it recovers boundaries from **on-disk persisted items, not the live stream**
  (`sessionParser.ts:103`, turn-slicing at `:127`).
- Correction: the **preferred** stored reader is the transcript
  (`parseSessionMessages` prefers `readOpenRouterTranscript`,
  `OpenRouterSessionProvider.ts:230`), and the transcript path **also merges** — the
  harness writes one assistant record per `response.completed` via `logTranscriptAssistant`
  with `extractAssistantContent` concatenating all message-item text and all reasoning text
  (`agent.js:1545`, `agent.js:2666`: `text += c.text`). Only the state.json fallback is
  per-item.

So the boundary information is preserved **on disk** (state.json) but is **not present in
the live event stream**, and is even lost in the preferred transcript reader.

## Conclusion

**Harness-level gap.** No faithful callboard-only fix exists: the only stream callboard
consumes has already flattened `message`/`reasoning` items (no id, phase, or boundary), the
harness exposes no raw-event hook, and `onHook` carries no per-item event.

## Proposed minimal real fix (in the harness)

Surface the per-item boundaries the harness already receives but drops:

1. Add an `AgentCoreEvent` boundary variant, e.g.
   `{ type: 'message_item_start', kind: 'message' | 'reasoning', itemId: string, phase?: 'commentary' | 'final_answer' }`,
   emitted from the existing raw-stream loop on `response.output_item.added` for
   `message`/`reasoning` items (the loop already has the event, `item.id`, and `item.phase`).
   (Equivalently: tag each `text_delta`/`reasoning_delta` with `itemId` so consumers flush
   on id-change.)
2. callboard's `translateOpenRouterEvents` keys off it to **flush the current live chat
   message and start a new discrete one**; `text_delta`/`reasoning_delta` accumulate into
   the current item; `tool_call`/`server_tool` already flush naturally. No trim, no
   separators, verbatim content, reasoning surfaced as its own message.

### Open question for the owner

Confirm sieve's outbound SSE emits `response.output_item.added/.done` per item (the SDK
clearly parses these event types, so it almost certainly does), and whether `session_id` is
stamped on the item for coordinator/worker identity. That determines whether step 1 can also
carry a `sessionId` for richer per-speaker rendering.
