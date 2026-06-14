/**
 * Captured Codex event stream from the Step-1 spike
 * (`plans/codex-spike-findings.md` §4): a subscription-auth run that created
 * `hello.txt` under `danger-full-access`. Held verbatim as the JSONL the
 * `codex exec --experimental-json` CLI emitted (one event per line) so
 * messageAdapter tests drive the *real* shape the SDK produces.
 *
 * Kept as a `.ts` constant rather than a loose `.jsonl` because the repo
 * compiles tests to `dist/` and runs them there too — a committed data file
 * wouldn't be emitted alongside the compiled test, so the fixture has to ride
 * in the module graph.
 */
export const HELLO_TXT_STREAM_JSONL = `
{"type":"thread.started","thread_id":"019ec7f2-cd5d-7823-b2d1-6683c42bfe32"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll create the requested file…"}}
{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/codex-work-4w9RVb/hello.txt","kind":"add"}],"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/codex-work-4w9RVb/hello.txt","kind":"add"}],"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Created \`hello.txt\` containing exactly \`hi from codex\`."}}
{"type":"turn.completed","usage":{"input_tokens":22311,"cached_input_tokens":19200,"output_tokens":71,"reasoning_output_tokens":0}}
`.trim();
