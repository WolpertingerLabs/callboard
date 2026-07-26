# Cross-harness handoff

Switching a conversation between the three agent harnesses — Claude Code, Codex,
OpenRouter — by forking it into a new chat whose native session already contains
the old one's history.

## Why a fork, not an in-place switch

A chat's harness is pinned for its lifetime:

- `sendMessage` writes `metadata.provider` only on the new-chat path
  (`services/claude.ts`), and every later message routes off that value.
- `GET /chats/:id/messages` picks ONE parser from `meta.provider` and runs the
  whole chat through it (`routes/chats.ts`). Flipping the provider in place
  would leave the pre-switch history unrenderable.

Forking sidesteps both: the new chat gets its own provider and its own native
session file, and one parser covers the whole thing.

## Shape

The read side is already harness-neutral — `SessionProvider.parseSessionMessages()`
returns `ParsedMessage[]` for every provider. So a handoff needs one **writer**
per target harness, not one translator per ordered pair: three implementations
instead of nine.

```
source provider          neutral middle              target provider
parseSessionMessages ──► truncateAtCutoff        ──► seedSession
   (ParsedMessage[])     buildHandoffTurns            (native session)
                          (HandoffTurn[])
```

- `agents/handoff.ts` — the neutral middle (flattening, preamble, cutoff).
- `SessionProvider.seedSession` — the optional port method each provider
  implements to write a resumable session from turns.
- `POST /chats/:id/fork` — takes an optional `provider` (plus `model` /
  `effort`) and picks the path.

`forkSession` (same-harness, copies the raw native log) is still preferred when
source and target match: it preserves real `tool_use` blocks, reasoning and ids
that the neutral projection necessarily drops. The seed path is used for a
harness switch, and as a fallback for same-harness forks on providers that have
no native fork (Codex, OpenRouter).

## Seed targets

| Harness | Written files | Resume mechanism |
| --- | --- | --- |
| claude-code | `<projectDir>/<sessionId>.jsonl` | SDK reads the JSONL by session id |
| codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl` | CLI scans the dated tree for a filename ending in the thread id |
| openrouter | `<logsRoot>/<sid>/{session.json,state.json,transcript.jsonl}` | harness resumes from `state.json`'s local `messages` |

Two findings that made this feasible, both contradicting comments previously in
the code:

- **Codex needs no sqlite row.** `$CODEX_HOME/state_*.sqlite` has a `threads`
  table mapping id → rollout path, but it backs the CLI's own history UI, not
  resume. A hand-written rollout with no row resumes fine (codex-cli 0.144.6).
- **OpenRouter's `previousResponseId` is not load-bearing.**
  `ConversationState.messages` is the full local history; the response id is
  only a server-side prefix-cache hint. The harness's own compaction and prune
  paths rewrite `messages` wholesale and delete the response id, then resume
  normally — a seeded history is the same situation.

The OR writer must emit `transcript.jsonl`, not just `state.json`:
`parseSessionMessages` *prefers* the transcript and the harness appends to it on
the next turn, so seeding without one would show the carried history until the
new session replied once, then lose it.

## Tool traffic is flattened to text

`ParsedMessage` carries enough to replay tool calls structurally, but tool
*names* don't survive the trip — Claude's `Bash`/`Read` have no counterpart in
Codex's `shell`/`apply_patch` or OpenRouter's `bash`. Replaying them verbatim
would seed the target with function calls naming tools absent from its tool
list.

So calls and results fold into the surrounding assistant turn as bracketed,
truncated text (2000 chars per blob), and a preamble states the provenance
plainly: another harness produced this history, the tool traffic is a summary
rather than the model's own calls, and the results are point-in-time.

Dropped: `thinking` (provider-specific signatures / encrypted payloads),
`system` (callboard plumbing), and subagent messages (`teamName` set).

## Verification

Each writer was driven end-to-end against the real engine, seeding a history
whose only source for a magic string was a *flattened tool result*, then asking
the resumed session to recall it without tools:

- **Codex** — `codex exec resume <id>` recalled `XYLOPHONE-7734` and attributed
  it to Claude Code.
- **OpenRouter** — `OpenRouterAgentRun` on the seeded `state.json` did the same.
- **Claude Code** — `claude -p --resume <id>` did the same, attributing it to
  Codex.

In all three the model correctly reported that *another* harness ran the
command, confirming the preamble does its job.

## Known limits

- Seeded history is uncached on the target, so the first turn re-reads the whole
  transcript. A prior 73-message fork cost ~$1.47 to resume.
- The Codex rollout format is undocumented and version-gated
  (`EXPECTED_CODEX_CLI_VERSION`); the writer carries ongoing drift risk the
  other two don't.
- Images referenced by `imageIds` are not carried across a handoff.
