# Captured Codex rollout fixtures

`rollout-cli-0.146.0.jsonl` and `rollout-cli-0.153.4.jsonl` are **real rollout
files**, written by the bundled `codex` binary, not hand-authored samples. They
exist because `sessionParser.ts` depends on the *text* of the CLI's injected
lead messages, and that text is undocumented, unversioned, and drifts between
CLI releases without any accompanying change to the SDK's type declarations. A
hand-written fixture modelled on remembered output cannot catch that drift —
one modelled on 0.146.0 is exactly why the `<skills_instructions>` leak shipped.

## How they were captured

Both were produced with identical flags, one prompt apart, against a scratch
`$CODEX_HOME` seeded only with `auth.json`:

```js
const codex = new Codex({});
const thread = codex.startThread({
  skipGitRepoCheck: true,
  workingDirectory: <scratch dir>,
  sandboxMode: "read-only",
  approvalPolicy: "never",
});
await thread.run("Reply with exactly the word OK and nothing else.");
```

- 0.146.0 — `npm i @openai/codex-sdk@0.146.0` in a temp dir; binary reports
  `codex-cli 0.146.0`.
- 0.153.4 — this repo's `node_modules/@openai/codex-linux-x64/vendor/…/bin/codex`;
  binary reports `codex-cli 0.153.4`.

`rollout-cli-0.153.4-resumed.jsonl` is the same 0.153.4 thread after a second
turn via `codex.resumeThread(...)`, kept because it shows the one thing a
single-turn capture cannot: a resumed turn **appends to the same file and the
CLI re-injects the lead run mid-transcript**. Any filter that reasons about
position ("everything before the first real user message") is wrong for that
reason, and this fixture is what says so.

## The one edit

`session_meta.payload.base_instructions.text` is replaced with a redaction
marker in both files. It is OpenAI's full Codex system prompt (18–22 KB, half
the file), this parser never reads its value, and the head-window scan that
does care about a large blob sitting in front of the meta scalars is covered
separately by `sessionParser.meta.test.ts`. Everything else is byte-for-byte
as the CLI wrote it.

## What they show

| | 0.146.0 | 0.153.4 |
| --- | --- | --- |
| developer #1 | `<permissions instructions>…<apps_instructions>…<plugins_instructions>…<skills_instructions>…` | `<skills_instructions>…<permissions instructions>…<collaboration_mode>…` |
| developer #2 | `` You are `/root`, the primary agent… `` (untagged) | `` <multi_agent_role>You are `/root`… `` |
| developer #3 | `<multi_agent_mode>…` | `<multi_agent_mode>…` |
| user #1 | `<recommended_plugins>…<environment_context>…` | `<recommended_plugins>…<environment_context>…` |
| user #2 | the real prompt | the real prompt |

Note that `<permissions instructions>` did not disappear at 0.153.4 — it moved
to second position *inside the same message*, which is precisely why a prefix
match stopped seeing it. The same move happened a version earlier on the user
side: 0.146.x prepended `<recommended_plugins>` to the `<environment_context>`
blob, knocking out that prefix too.

Nothing here is user-authored except the two prompts (`Reply with exactly the
word OK…`, `Now reply with exactly the word TWO.`) — every other opening
literal above was confirmed present in the bundled `codex` binary with
`grep -a -F`, in both 0.146.0 and 0.153.4.

## Live-stream captures (`stream-cli-0.153.4-*.jsonl`)

The `rollout-*` files above are the **durable** format. These two are the
**public** one — raw stdout of `codex exec --experimental-json`, i.e. exactly
the bytes `@openai/codex-sdk`'s `runStreamed().events` generator parses and
hands to `messageAdapter.ts`.

Both lanes describe the same run and they are **not the same encoding**:

| durable rollout (`event_msg`)             | public stream (`--experimental-json`)                        |
| ----------------------------------------- | ------------------------------------------------------------ |
| `AgentMessage` `{content[], phase}`        | `agent_message` `{id, type, text}`                            |
| `Reasoning` `{summary_text[], raw_content}`| `reasoning` `{id, type, text}`                                |
| `CommandExecution` (`command` an array)    | `command_execution` (`command` a string, `aggregated_output`) |
| `ContextCompaction`, `UserMessage`         | *(absent — rollout-only)*                                     |

They exist because reading the PascalCase rollout as if it were the stream leads
directly to a wrong diagnosis: it looks like the adapter's snake_case `switch`
must be falling through and dropping everything, when in fact the CLI translates
between the lanes and the adapter is correct. These captures pin the encoding
the adapter actually targets.

Captured with the bundled CLI (0.153.4):

```
codex exec --experimental-json --skip-git-repo-check \
  --dangerously-bypass-approvals-and-sandbox -m gpt-6-astra \
  [-c model_reasoning_effort=high -c model_reasoning_summary=detailed] \
  -C <scratch dir> '<prompt>' > raw.jsonl
```

- `stream-cli-0.153.4-reasoning.jsonl` — `agent_message`, a non-empty
  `reasoning` item, and a `command_execution` pair.
- `stream-cli-0.153.4-file-change.jsonl` — adds a `file_change` pair.

## `rollout-cli-0.153.4-compacting.jsonl`

Byte-verbatim `item_completed` and `token_count` lines from the real failed run
(chat `01a07b74`, 2026-09-07) that motivated `rolloutTail.ts` — the one whose
1.4 MB system prompt forced a compaction on every turn. Selected with
`grep -E '"type":"(item_completed|token_count)"'`; the 1.4 MB `session_meta`
line and the six ~83 KB `compacted` payloads are omitted so the fixture stays
24 KB, but every retained line is unmodified.

Contains six genuine `ContextCompaction` records with their real ids, thirteen
`token_count` records carrying `model_context_window: 258400`, and
`AgentMessage` / `CommandExecution` / `Reasoning` / `UserMessage` lines that the
extractor must ignore. Regenerating it from a synthetic run would lose exactly
the property under test: that real compaction records are recognised, and that
nothing else in a real rollout is mistaken for one.
