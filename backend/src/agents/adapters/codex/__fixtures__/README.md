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
match stopped seeing it.
