/**
 * Codex session parser — reads a Codex CLI "rollout" file and projects it into
 * callboard's neutral {@link ParsedMessage} shape.
 *
 * **One file == one thread.** The Codex CLI writes a single JSONL "rollout" per
 * thread at
 *
 *     $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO-with-dashes>-<thread_id>.jsonl
 *
 * and a resumed turn APPENDS to that same file (spike §5 — no fork/copy). The
 * trailing UUID in the filename is the `thread_id`, identical to the id from the
 * `thread.started` event and the value passed to `resumeThread`. callboard uses
 * that thread_id as the session id.
 *
 * The rollout is a distinct, undocumented format from the SDK event stream — do
 * NOT reuse `messageAdapter` here. Each line is a `{ type, payload, timestamp? }`
 * record. The line `type`s we read:
 *
 *  - `session_meta` (line 1) — `payload:{ id, timestamp, cwd, cli_version,
 *    base_instructions:{text} }`. Source of the session id, working folder, and
 *    the `cli_version` we version-gate on (spike risk #4 — format may drift).
 *  - `response_item` — the durable transcript. `payload.type`:
 *    - `"message"` (`role: "user"|"assistant"|"developer"|"system"`,
 *      `content:[{type:"input_text"|"output_text", text}]`) → text.
 *      A **variable-length run of synthetic messages** precedes the real
 *      transcript, and the CLI re-injects it ahead of every resumed turn. Its
 *      contents grow and get reordered between CLI versions, so it is filtered
 *      by channel rather than by content where possible: `developer` is dropped
 *      wholesale (see {@link translateMessage}) and the handful of synthetic
 *      `user` messages by tag prefix ({@link SYNTHETIC_MESSAGE_PREFIXES}). The
 *      real user prompt is the first `user` message that survives.
 *    - `"function_call"` / `"custom_tool_call"` → `tool_use`
 *      (`commandExecution`/`fileChange`/`mcpToolCall` all serialize through these
 *      Responses-API item shapes in the rollout).
 *    - `"function_call_output"` / `"custom_tool_call_output"` → `tool_result`.
 *    - `"reasoning"` → `thinking`.
 *    - `"agent_message"` → attributed system/agent_message context (not root
 *      assistant output); protected blocks are explicit unavailable markers.
 *
 * Unknown line/item types are skipped silently — the rollout schema is
 * forward-compatible with additions, and so are we.
 *
 * @see plans/codex-adapter-job.md (Step 9 session-provider)
 * @see plans/codex-spike-findings.md §5 (rollout format)
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { ParsedMessage } from "shared/types/index.js";
import { getAgentSettings } from "../../../services/agent-settings.js";
import { storeBase64Image } from "../../../services/image-storage.js";
import { scanJsonlLines } from "../../../utils/jsonl-scan.js";
import { createLogger } from "../../../utils/logger.js";
import { DATA_DIR } from "../../../utils/paths.js";

import { collaborationArguments, translateCollaborationMessage } from "./collaboration.js";

const log = createLogger("codex-session-parser");

/**
 * The Codex CLI version this parser was written against (spike §1). The rollout
 * format is undocumented and version-dependent; when a rollout's
 * `session_meta.cli_version` differs we log so a future format drift is
 * diagnosable rather than silently mis-parsed (spike risk #4).
 *
 * ## What the 0.153.4 bump (from 0.146.0) actually verified
 *
 * **Structure, and only structure.** Every discriminant this parser switches
 * on is still emitted by the bundled `codex` binary: the `session_meta` /
 * `turn_context` / `event_msg` / `response_item` line types, the `token_count`
 * event, the `message` / `function_call` / `custom_tool_call` /
 * `function_call_output` / `custom_tool_call_output` / `reasoning` item types,
 * and the `cached_input_tokens` / `reasoning_output_tokens` usage keys.
 *
 * ## What that check does NOT cover — re-check it on every bump
 *
 * This parser also depends on the **text** of the CLI's injected lead messages
 * ({@link SYNTHETIC_MESSAGE_PREFIXES}), and that text drifts independently of
 * the structure. 0.153.4 reordered the first `developer` blob so it opens with
 * `<skills_instructions>` instead of `<permissions instructions>`, which the
 * prefix list did not match — a ~2.5 KB boilerplate block leaked into the head
 * of every transcript, with no structural change to point at it. The SDK's
 * `.d.ts` describes none of this; diffing the type declarations cannot show it.
 *
 * So bumping this constant is not bookkeeping — it silences the boot-time
 * drift warning that exists to force exactly this re-check. Before bumping:
 * run the newly bundled binary, capture a rollout, and diff its `response_item`
 * `message` leads against `__fixtures__/rollout-*.jsonl`.
 */
export const EXPECTED_CODEX_CLI_VERSION = "0.153.4";

/**
 * Tag prefixes of the synthetic messages the Codex CLI injects into the **user**
 * channel. Matched case-insensitively against the trimmed start of a message.
 *
 * Deliberately an explicit allowlist rather than a shape heuristic ("starts
 * with a snake_case XML tag"): real user content in these rollouts does start
 * with tags — `<image name=[Image #1] path="…">` for an attachment, and
 * callboard's own `<conversation_handoff from="…">` — and swallowing a user's
 * prompt is far worse than leaking a boilerplate block. The `developer` channel
 * needs no such caution and is filtered wholesale; see {@link translateMessage}.
 *
 * Entries are additive across CLI versions and none are retired, because
 * rollouts written by older CLIs stay on disk and stay parseable. `<permissions`
 * and `<skills_instructions` only ever led `developer` messages, so the role
 * filter now covers them, but they are kept here as the belt to that braces:
 * the cost is a string compare, and the failure they guard against shipped once
 * already.
 *
 * `<recommended_plugins` was added by 0.146.x, prepended to the
 * `<environment_context` blob *inside the same user message*, which knocked out
 * that prefix. That leak predates the 0.153.4 bump and hit
 * {@link readFirstUserPrompt} too — every chat started under 0.146.x previews
 * in the sidebar as OpenAI's plugin catalogue instead of the user's prompt.
 *
 * `<user_instructions` is the one entry no rollout on this machine and no
 * literal in the 0.153.4 binary still exercises, so its provenance is recorded
 * rather than assumed. It was real, and it was on *this* channel: through
 * rust-v0.50.0 `UserInstructions::serialize_to_xml` wrapped AGENTS.md in
 * `<user_instructions>…</user_instructions>` and `impl From<UserInstructions>
 * for ResponseItem` emitted it as `role: "user"` — codex's own
 * `event_mapping.rs` then filtered it back out with the same two prefixes this
 * list leads with. rust-v0.20.0 is older still and prepends the identical tag.
 * By rust-v0.100.0 the wrapper had become `# AGENTS.md instructions for <dir>`
 * and the tag survived only as `USER_INSTRUCTIONS_OPEN_TAG_LEGACY`, for reading
 * old rollouts; by rust-v0.139.0 only an unused const remained. Kept for the
 * same reason as the rest — a rollout written by one of those CLIs is still
 * parseable, and still on someone's disk.
 */
const SYNTHETIC_MESSAGE_PREFIXES = [
  "<recommended_plugins", // 0.146.x — displaced `<environment_context` in the first user message
  "<environment_context",
  "<skills_instructions", // 0.153.4 — displaced `<permissions` as the first developer blob
  "<permissions", // ≤0.146.x — the lead of every rollout already on disk
  "<user_instructions", // ≤ rust-v0.5x — retired upstream; kept for rollouts of that vintage
];

/**
 * CLI versions already warned about. A single boolean latch hid every drift
 * after the first: once the process read any stale rollout it went quiet, and
 * right after a bump *every* rollout on disk is stale — so the one warning
 * always burned on the old version and the next real drift was silent. Keyed
 * per version instead, bounded by the number of CLI versions that ever wrote
 * to this machine (3 here), which keeps it noise rather than spam.
 */
const warnedCliVersions = new Set<string>();

/** Test seam — clears the per-version warning latch. */
export function resetCodexCliVersionWarnings(): void {
  warnedCliVersions.clear();
}

// ── Home / sessions-root resolution ─────────────────────────────────

/**
 * Resolve `$CODEX_HOME` the same way the write side does (`getApiEnvOverrides`
 * injects `CODEX_HOME` into the Codex subprocess env). Keeping the read side in
 * lockstep means callboard lists exactly the sessions the CLI wrote.
 *
 * Resolution order (first match wins):
 *   1. `getAgentSettings().codexHome` if set
 *   2. `$CODEX_HOME` env if set
 *   3. `<os.homedir()>/.codex` (the CLI default)
 */
export function resolveCodexHome(): string {
  const fromSettings = getAgentSettings().codexHome?.trim();
  if (fromSettings) return fromSettings;
  const env = process.env.CODEX_HOME?.trim();
  if (env) return env;
  return join(homedir(), ".codex");
}

/** The dated-tree root the rollout files live under: `$CODEX_HOME/sessions`. */
export function resolveCodexSessionsRoot(): string {
  return join(resolveCodexHome(), "sessions");
}

// ── Filename / thread-id helpers ────────────────────────────────────

/**
 * Match a rollout filename and pull out the trailing `thread_id` UUID. The
 * filename embeds BOTH an ISO timestamp (with `:` rewritten to `-`) and the
 * thread UUID, so a naive split on `-` is ambiguous — anchor on the canonical
 * 8-4-4-4-12 hex UUID at the end instead.
 *
 *   rollout-2026-06-14T17-03-58-019ec7f2-cd5d-7823-b2d1-6683c42bfe32.jsonl
 *                                └──────────────── thread_id ───────────┘
 */
const ROLLOUT_FILENAME_RE = /^rollout-.*-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

export function extractThreadIdFromFilename(filename: string): string | null {
  const m = ROLLOUT_FILENAME_RE.exec(filename);
  return m ? m[1]! : null;
}

// ── Raw line shapes (only the fields we read) ───────────────────────

interface RolloutLine {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

export interface SessionMeta {
  isNativeThread?: true;
  nativeAgent?: { parentThreadId: string; nickname?: string; agentPath?: string; role?: string; depth?: number };
  historyStartOrdinal?: number;
  id?: string;
  cwd?: string;
  timestamp?: string;
  cliVersion?: string;
}

/** The token-usage shape Codex writes inside an `event_msg`/`token_count` line. */
interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

/**
 * Map Codex's `last_token_usage` onto callboard's {@link ParsedMessage.usage}.
 *
 * Codex's `input_tokens` is the FULL prompt count *including* the cached
 * subset (`cached_input_tokens`), whereas callboard's debug panel (mirroring
 * Claude) treats `input_tokens` as the non-cached remainder and shows the cache
 * read separately. So we subtract the cached portion off `input_tokens` to keep
 * the In / Cache-R columns from double-counting, and surface the cached subset as
 * `cache_read_input_tokens` and the reasoning trace as `reasoning_tokens`. Codex
 * has no prompt-cache *write* metric (returns `undefined`), and subscription mode
 * reports no USD cost (left to the caller).
 */
function mapCodexUsage(u: CodexTokenUsage | undefined): ParsedMessage["usage"] | undefined {
  if (!u || typeof u !== "object") return undefined;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cached = typeof u.cached_input_tokens === "number" ? u.cached_input_tokens : 0;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const reasoning = typeof u.reasoning_output_tokens === "number" ? u.reasoning_output_tokens : 0;
  const usage: NonNullable<ParsedMessage["usage"]> = {
    input_tokens: Math.max(0, input - cached),
    output_tokens: output,
  };
  if (cached > 0) usage.cache_read_input_tokens = cached;
  if (reasoning > 0) usage.reasoning_tokens = reasoning;
  return usage;
}

/**
 * Read + parse a rollout file into `{ type, payload }` line records, dropping
 * blank/malformed lines. Returns `[]` for a missing/unreadable file.
 */
function readRolloutLines(filePath: string): RolloutLine[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const lines: RolloutLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      lines.push({});
      continue;
    }
    try {
      lines.push(JSON.parse(trimmed) as RolloutLine);
    } catch {
      lines.push({}); // Preserve physical ordinals across malformed lines.
    }
  }
  return lines;
}

/**
 * Read a rollout's lines lazily, stopping the moment `visit` returns a value.
 *
 * Rollouts run to megabytes (the largest on a real device is ~2 MB) but the two
 * fields the chat list needs — `session_meta.cwd` and the first user prompt —
 * sit at the very top. {@link readRolloutLines} slurps and `JSON.parse`s the
 * whole file, so answering "what cwd is this?" for every rollout used to read
 * the entire corpus.
 *
 * The chunked scan that fixes it now lives in `utils/jsonl-scan.ts`, because
 * every session format here is JSONL and the Claude Code parser wanted the same
 * thing for the same reason — see that module's header for the decoding and
 * torn-line reasoning this used to carry. This stays as the rollout-typed door
 * onto it.
 */
function scanRolloutLines<T>(filePath: string, visit: (line: RolloutLine) => T | undefined): T | undefined {
  return scanJsonlLines<T>(filePath, (line) => visit(line as RolloutLine));
}

/** First read of {@link readFirstLine}: most `session_meta` lines on a real device are larger, but the fixtures and seeded handoffs are not. */
const FIRST_LINE_INITIAL_BYTES = 8192;
/** Subsequent reads double from here up to {@link FIRST_LINE_MAX_CHUNK_BYTES}. */
const FIRST_LINE_GROWTH_BYTES = 64 * 1024;
const FIRST_LINE_MAX_CHUNK_BYTES = 1024 * 1024;

/** `readFirstLine` ran out of budget before reaching the end of the line — transient, not evidence about the file. */
const BUDGET_EXHAUSTED = Symbol("budget-exhausted");

/**
 * Read the first physical line of a file, and only that line.
 *
 * The line is read in growing chunks and the read stops at the first newline,
 * so a rollout pays for its `session_meta` and nothing after it — never a
 * whole-file slurp, and never a fixed 1 MB head that reads transcript the
 * caller does not want. There is no cap on the line itself: a `session_meta`
 * whose `base_instructions` runs past 1 MB (the uncapped agent prompt does
 * this today) is still the same one record, and a reader that gives up on it
 * makes the rollout invisible to discovery, un-resumable, and — because
 * "unreadable" used to be indistinguishable from "native child" — read-only.
 *
 * `budget` is charged for the bytes actually read (bounded by `size`, the
 * file's stat size, so a small rollout never costs a full chunk). Running out
 * mid-line returns {@link BUDGET_EXHAUSTED} so the caller can tell a spent
 * budget from a malformed file; `null` means the file could not be read.
 */
function readFirstLine(filePath: string, size: number, budget?: MetadataReadBudget): string | null | typeof BUDGET_EXHAUSTED {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    let chunkBytes = FIRST_LINE_INITIAL_BYTES;
    for (;;) {
      let want = Math.min(chunkBytes, size - offset);
      if (budget) want = Math.min(want, budget.remainingBytes);
      if (want <= 0) return offset >= size ? Buffer.concat(chunks).toString("utf-8") : BUDGET_EXHAUSTED;
      const buf = Buffer.allocUnsafe(want);
      const read = buf.subarray(0, readSync(fd, buf, 0, want, offset));
      if (budget) budget.remainingBytes -= read.length;
      if (read.length === 0) return Buffer.concat(chunks).toString("utf-8");
      const newline = read.indexOf(0x0a);
      chunks.push(newline >= 0 ? read.subarray(0, newline) : read);
      if (newline >= 0) return Buffer.concat(chunks).toString("utf-8");
      offset += read.length;
      chunkBytes = chunkBytes < FIRST_LINE_GROWTH_BYTES ? FIRST_LINE_GROWTH_BYTES : Math.min(chunkBytes * 2, FIRST_LINE_MAX_CHUNK_BYTES);
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function buildSessionMeta(payload: Record<string, unknown>): SessionMeta {
  const meta: SessionMeta = {};
  if (typeof payload.id === "string") meta.id = payload.id;
  if (typeof payload.cwd === "string") meta.cwd = payload.cwd;
  if (typeof payload.timestamp === "string") meta.timestamp = payload.timestamp;
  if (typeof payload.cli_version === "string") meta.cliVersion = payload.cli_version;
  const source = payload.source as { subagent?: { thread_spawn?: Record<string, unknown> } } | undefined;
  const spawn = source?.subagent?.thread_spawn;
  if (spawn || payload.thread_source === "subagent") meta.isNativeThread = true;
  const parent = spawn?.parent_thread_id;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (
    typeof parent === "string" &&
    uuid.test(parent) &&
    meta.id &&
    uuid.test(meta.id) &&
    parent !== meta.id &&
    (!payload.parent_thread_id || payload.parent_thread_id === parent)
  ) {
    meta.nativeAgent = {
      parentThreadId: parent,
      ...(typeof spawn?.agent_nickname === "string" && { nickname: spawn.agent_nickname }),
      ...(typeof spawn?.agent_path === "string" && { agentPath: spawn.agent_path }),
      ...(typeof spawn?.agent_role === "string" && { role: spawn.agent_role }),
      ...(typeof spawn?.depth === "number" && { depth: spawn.depth }),
    };
    if (Number.isSafeInteger(payload.subagent_history_start_ordinal) && Number(payload.subagent_history_start_ordinal) >= 1)
      meta.historyStartOrdinal = Number(payload.subagent_history_start_ordinal);
  }
  checkCliVersion(meta.cliVersion);
  return meta;
}

/**
 * Memo for {@link readCodexSessionMeta}, keyed by path and invalidated by the
 * file's device/inode, nanosecond ctime/mtime, and size.
 *
 * `session_meta` is line 1 and a resume only ever *appends*, so the meta itself
 * is immutable — but keying on the stat means a rewritten rollout (a seeded
 * handoff reusing a path, a hand-edited file) can never serve a stale cwd, and
 * the invalidation rule is the same one a reader would guess.
 *
 * Bounded so a long-lived daemon that accumulates rollouts doesn't grow the map
 * without limit. Which entry the bound drops matters more than it looks, because
 * the only access pattern that can overflow this memo is a **cyclic full-corpus
 * walk**: `discoverSessions` asks every rollout for its cwd on every chat-list
 * request, in a stable mtime-DESC order, and `~/.codex/sessions` is append-only
 * and never pruned — so a user crosses the bound once and stays across it.
 *
 * Against a cyclic scan, dropping the *oldest* entry (FIFO, and equally LRU) is
 * the textbook sequential-flooding pathology: the entry evicted is precisely the
 * one the next pass asks for first, so every access misses and the hit rate is
 * 0% forever. That is a cliff at a hard threshold, not a taper — the warm pass
 * reverts to the cost of a cold one for exactly the heaviest users, and it
 * presents as "the sidebar got slow again" with nothing to blame.
 *
 * So eviction takes the **most recently inserted** entry instead, which for this
 * pattern is what Belady's optimal policy would choose (in a cycle, the entry
 * just used is the one needed farthest in the future). The first MAX rollouts of
 * the walk — the newest ones, i.e. the page the sidebar actually shows — stay
 * resident, and only the tail pays a head-read per pass: hit rate MAX/N,
 * degrading smoothly instead of collapsing. Below the bound no entry is ever
 * evicted, so the policy is invisible until it is the only thing that matters.
 */
export const META_CACHE_MAX = 4096;
const metaCache = new Map<string, { key: string; meta: SessionMeta | null }>();
/** Key of the newest insertion — the one eviction takes when the memo is full. */
let metaCacheNewest: string | null = null;

/** Drop every memoized `session_meta`. Test seam — production never needs it. */
export function clearCodexSessionMetaCache(): void {
  metaCache.clear();
  metaCacheNewest = null;
}

/**
 * Aggregate read allowance shared across one discovery pass. Charged for bytes
 * actually read — a memo hit costs nothing, a small rollout costs its size —
 * so the number of rollouts a pass can see is a function of their headers, not
 * of a fixed per-file price. Exhaustion is transient: the rollout that ran out
 * is not memoized as "no meta" and is read on the next pass.
 */
export interface MetadataReadBudget {
  remainingBytes: number;
}

/**
 * The `session_meta` is the complete first record and nothing else: a later
 * line claiming to be one is inherited fork history, not this thread's own
 * header, so only line 1 is ever consulted.
 */
function readBoundedSessionMeta(filePath: string, size: number, budget?: MetadataReadBudget): SessionMeta | null | typeof BUDGET_EXHAUSTED {
  const line = readFirstLine(filePath, size, budget);
  if (line === BUDGET_EXHAUSTED) return line;
  const record = parseObject(line ?? "");
  if (record?.type !== "session_meta") return null;
  return buildSessionMeta((record.payload ?? {}) as Record<string, unknown>);
}

/**
 * Read just the `session_meta` (complete first record) of a rollout. Used by the
 * provider for discovery (folder, sort timestamp) and id resolution without
 * parsing the whole transcript.
 *
 * Memoized per file version — discovery asks this of every rollout on every
 * chat-list request, and the answer only changes when the file does.
 */
export function readCodexSessionMeta(filePath: string, budget?: MetadataReadBudget): SessionMeta | null {
  let key: string;
  let size: number;
  try {
    const st = statSync(filePath, { bigint: true });
    key = `${st.dev}:${st.ino}:${st.ctimeNs}:${st.mtimeNs}:${st.size}`;
    size = Number(st.size);
  } catch {
    // Unreadable/missing: answer "no meta", the same thing the scan would have
    // answered before there was a cache, without memoizing anything for a file
    // we couldn't stat — so the answer isn't pinned once the file appears.
    return null;
  }

  const cached = metaCache.get(filePath);
  if (cached && cached.key === key) return cached.meta;

  const meta = readBoundedSessionMeta(filePath, size, budget);
  // Budget exhaustion is transient, not evidence of malformed metadata.
  if (meta === BUDGET_EXHAUSTED) return null;

  // Refreshing an entry already held doesn't grow the map, so it evicts nothing.
  if (metaCache.size >= META_CACHE_MAX && !metaCache.has(filePath)) {
    // Newest-out (see the note on `metaCache`). The oldest-out fallback only
    // matters if `metaCacheNewest` were ever missing from the map, which it
    // cannot be — it exists so the bound holds regardless.
    if (metaCacheNewest === null || !metaCache.delete(metaCacheNewest)) {
      const oldest = metaCache.keys().next();
      if (!oldest.done) metaCache.delete(oldest.value);
    }
  }
  metaCache.set(filePath, { key, meta });
  metaCacheNewest = filePath;
  return meta;
}

/** Warn once per distinct CLI version that wrote a rollout we don't target. */
function checkCliVersion(cliVersion: string | undefined): void {
  if (!cliVersion || cliVersion === EXPECTED_CODEX_CLI_VERSION || warnedCliVersions.has(cliVersion)) return;
  warnedCliVersions.add(cliVersion);
  log.warn(
    `Codex rollout cli_version=${cliVersion} differs from the version this parser targets ` +
      `(${EXPECTED_CODEX_CLI_VERSION}); session parsing may be lossy if the rollout format drifted.`,
  );
}

// ── Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a Codex rollout file into ParsedMessage[]. The provider calls this for
 * each session id in a (possibly resumed) chat. Thin by design — the rollout
 * format is undocumented (spike §5), so we translate only the well-understood
 * line/item types and skip the rest.
 */
export function parseCodexRollout(filePath: string): ParsedMessage[] {
  const rawLines = readRolloutLines(filePath);
  const ownMeta = readCodexSessionMeta(filePath);
  if (!ownMeta && rawLines.some((line) => line.type === "session_meta")) return []; // Ambiguous fork headers cannot authorize inherited-history display.
  // Fork rollouts copy historical events (including session_meta and terminal events).
  // The installed CLI records the first child-local ordinal. Without it, fail closed.
  const lines = ownMeta?.isNativeThread ? (ownMeta.historyStartOrdinal === undefined ? [] : rawLines.slice(ownMeta.historyStartOrdinal)) : rawLines;
  const messages: ParsedMessage[] = [];
  // Version-gate off the meta line even when a caller skips readCodexSessionMeta.
  const meta = lines.find((l) => l.type === "session_meta");
  if (meta) checkCliVersion(typeof meta.payload?.cli_version === "string" ? meta.payload.cli_version : undefined);

  // The rollout interleaves three line kinds we care about (verified against
  // real captures):
  //   - `turn_context` — opens a turn, carries the `model` + `turn_id`. One per
  //     user prompt; the model holds across that turn's (possibly many) tool-loop
  //     generations.
  //   - `response_item` — the durable transcript (messages/tools/reasoning).
  //   - `event_msg`/`token_count` — fires at the END of each generation with
  //     `info.last_token_usage` for the generation that just completed.
  // So we stamp `model` on every assistant message and attach each generation's
  // usage to its canonical entry: the last assistant message emitted before the
  // matching `token_count`. This is what populates the responses/debug table and
  // the per-message model label (both were empty before — assistant messages
  // carried neither model nor usage).
  let currentModel: string | undefined;
  let currentTurnId: string | undefined;
  let genCounter = 0;
  // Assistant messages emitted since the last token_count — the generation in
  // flight. On a token_count the last of these is the canonical entry.
  let pendingAssistant: ParsedMessage[] = [];

  for (const line of lines) {
    if (line.type === "turn_context") {
      const p = line.payload ?? {};
      if (typeof p.model === "string") currentModel = p.model;
      if (typeof p.turn_id === "string") currentTurnId = p.turn_id;
      continue;
    }

    if (line.type === "event_msg" && line.payload?.type === "token_count") {
      const info = line.payload.info as { last_token_usage?: CodexTokenUsage } | undefined;
      const usage = mapCodexUsage(info?.last_token_usage);
      const canonical = pendingAssistant[pendingAssistant.length - 1];
      if (canonical && usage) {
        canonical.usage = usage;
        if (currentModel) canonical.model = currentModel;
        // Distinct identity per generation so the debug table renders one row
        // each instead of collapsing the turn's tool-loop into one.
        canonical.generationKey = `${currentTurnId ?? "turn"}/${genCounter}`;
        if (currentTurnId) canonical.requestId = currentTurnId;
      }
      genCounter++;
      pendingAssistant = [];
      continue;
    }

    if (line.type !== "response_item") continue;
    const parsed = translateResponseItem(line.payload, line.timestamp);
    if (!parsed) continue;
    if (parsed.role === "assistant") {
      if (currentModel) parsed.model = currentModel;
      pendingAssistant.push(parsed);
    }
    messages.push(parsed);
  }
  return messages;
}

/**
 * Translate one `response_item` payload into a ParsedMessage, or `null` to drop
 * it (synthetic lead messages, empty content, unhandled item types).
 */
function translateResponseItem(payload: Record<string, unknown> | undefined, timestamp: string | undefined): ParsedMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const itemType = typeof payload.type === "string" ? payload.type : undefined;
  const ts = typeof timestamp === "string" ? timestamp : undefined;

  switch (itemType) {
    case "agent_message":
      return translateCollaborationMessage(payload, ts);

    case "message":
      return translateMessage(payload, ts);

    // Assistant tool invocation. `function_call` carries JSON `arguments`;
    // `custom_tool_call` (the apply-patch / freeform tools) carries `input`.
    case "function_call":
    case "custom_tool_call": {
      const name = typeof payload.name === "string" ? payload.name : "<unknown>";
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const content =
        typeof payload.arguments === "string"
          ? payload.arguments
          : typeof payload.input === "string"
            ? payload.input
            : extractText(payload.arguments ?? payload.input);
      return {
        role: "assistant",
        type: "tool_use",
        toolName: payload.namespace === "collaboration" && !name.startsWith("collaboration.") ? `collaboration.${name}` : name,
        ...(typeof payload.namespace === "string" && { toolNamespace: payload.namespace }),
        content: collaborationArguments(name, payload.namespace, content),
        ...(callId && { toolUseId: callId }),
        ...(ts && { timestamp: ts }),
      };
    }

    // Tool result — surfaced as user-role for parity with Claude's
    // tool_use → tool_result pairing.
    case "function_call_output":
    case "custom_tool_call_output": {
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const content = extractText(payload.output);
      return {
        role: "user",
        type: "tool_result",
        content,
        ...(callId && { toolUseId: callId }),
        ...(ts && { timestamp: ts }),
      };
    }

    case "reasoning": {
      const content = extractText(payload.summary ?? payload.content);
      if (!content) return null;
      return { role: "assistant", type: "thinking", content, ...(ts && { timestamp: ts }) };
    }

    default:
      return null;
  }
}

/** Translate a `payload.type === "message"` item, filtering synthetic leads. */
function translateMessage(payload: Record<string, unknown>, ts: string | undefined): ParsedMessage | null {
  const role = typeof payload.role === "string" ? payload.role : undefined;

  // `developer` is an injection channel — CLI- or client-authored — not a
  // conversational role, so drop it wholesale rather than chasing the tag of
  // the week.
  //
  // Evidence: across the 374 rollouts in `$CODEX_HOME` on this machine
  // (cli_version 0.139.0 / 0.146.0 / 0.146.1) all 411 developer messages are one
  // of five CLI-authored blobs — `<permissions instructions>`,
  // `<skills_instructions>`, `<multi_agent_mode>`, `<model_switch>`, and the
  // multi-agent role brief — and each of those opening literals is compiled
  // into the bundled `codex` binary. The 0.153.4 rollouts in `__fixtures__` add
  // no sixth kind. Nothing callboard sends can land here either: its own
  // instructions ride `model_instructions_file` into
  // `session_meta.base_instructions`, and `thread.run()` emits `user`.
  //
  // A tag allowlist cannot replace this. At 0.146.0 the multi-agent brief has
  // no tag at all — it opens "You are `/root`, the primary agent…" — so it
  // leaked for as long as the filter was prefix-only. Nor can a positional
  // rule ("everything before the first real user message"): a resumed turn
  // APPENDS to the same rollout and the CLI re-injects the whole lead run
  // mid-file, verified in `__fixtures__/rollout-cli-0.153.4-resumed.jsonl`.
  //
  // ## The one case this filter is known to over-reach on
  //
  // Codex has a first-class *client*-authored developer path:
  // `Session::inject_client_response_items` → `annotate_client_response_item`
  // records a `ResponseItem::Message { role: "developer" }` an app-server client
  // supplied. Callboard cannot produce one — `@openai/codex-sdk@0.153.4` types
  // `Input` as `string | ({type:"text"} | {type:"local_image"})[]`, `Thread`
  // exposes no inject API, `HandoffTurn.role` (`agents/handoff.ts`) is
  // `"user" | "assistant"`, and there is no `forkSession` — so no chat
  // callboard *starts* can hit it. But discovery walks the whole of
  // `$CODEX_HOME/sessions`, including rollouts callboard never wrote, so a user
  // who also runs an app-server/IDE client that injects developer context loses
  // it here silently.
  //
  // If a missing-message report ever arrives, the discriminator to reach for is
  // `metadata.client_authored` — a sibling of `payload` on the rollout line,
  // not a field inside it (`{"metadata":{"client_authored":true},"payload":
  // {"type":"message","role":"developer",…}}`). It is not usable as a filter
  // today: `annotate_client_response_item` only attaches that metadata when
  // `Feature::RetainClientDeveloperMessages` is on, and 0.153.4 ships it
  // `Stage::UnderDevelopment, default_enabled: false` — so a client-injected
  // developer message currently lands with no metadata at all and is byte-for-
  // byte indistinguishable from a CLI-authored one. Widening the filter has to
  // wait for that flag to stabilize.
  if (role === "developer") return null;

  const { text: content, imageIds } = extractTextAndImages(payload.content);
  if (!content && imageIds.length === 0) return null;

  // Drop the CLI's synthetic user-channel messages — the environment context
  // and plugin catalogue it prepends ahead of the real prompt. Matched by tag
  // prefix ({@link SYNTHETIC_MESSAGE_PREFIXES}), which stays conservative
  // because this channel also carries genuine user content.
  const head = content.trimStart().toLowerCase();
  if (SYNTHETIC_MESSAGE_PREFIXES.some((p) => head.startsWith(p))) return null;

  const mappedRole: ParsedMessage["role"] = role === "assistant" ? "assistant" : role === "user" ? "user" : "system";

  return { role: mappedRole, type: "text", content, ...(imageIds.length > 0 && { imageIds }), ...(ts && { timestamp: ts }) };
}

/**
 * Extract user-visible text plus rehydratable image IDs from Codex rollout
 * content. The Codex CLI serializes local image inputs in at least two shapes:
 *
 *   - structured blocks: `{ type: "local_image", path }`
 *   - XML-ish text in string content:
 *     `<image name=[Image #1] path="/path/to/image.png">[image]</image>`
 *
 * Callboard stores uploaded images under DATA_DIR/images and, for older runs,
 * may also see temporary `/tmp/callboard-codex-image-*` paths. Convert readable
 * image paths back into Callboard image IDs so the existing frontend thumbnail
 * renderer can show the actual image instead of raw markup.
 */
function extractTextAndImages(content: unknown): { text: string; imageIds: string[] } {
  const imageIds: string[] = [];
  const addPath = (path: string): void => {
    const id = storeImagePathIfAllowed(path);
    if (id && !imageIds.includes(id)) imageIds.push(id);
  };

  if (content === null || content === undefined) return { text: "", imageIds };

  if (typeof content === "string") {
    const text = stripCodexImageTags(content, addPath);
    return { text, imageIds };
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        const text = stripCodexImageTags(block, addPath);
        if (text) textParts.push(text);
        continue;
      }
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") {
        const text = stripCodexImageTags(b.text, addPath);
        if (text) textParts.push(text);
        continue;
      }
      if ((b.type === "input_image" || b.type === "image" || b.type === "local_image") && typeof b.path === "string") {
        addPath(b.path);
        continue;
      }
      if ((b.type === "input_image" || b.type === "image") && typeof b.image_url === "string") {
        const id = storeDataUriImage(b.image_url);
        if (id && !imageIds.includes(id)) imageIds.push(id);
        continue;
      }
      if (b.type === "input_image" || b.type === "image" || b.type === "local_image") {
        textParts.push("[image]");
      }
    }
    return { text: textParts.filter((s) => s.length > 0).join("\n"), imageIds };
  }

  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") {
      return { text: stripCodexImageTags(obj.text, addPath), imageIds };
    }
  }

  return { text: extractText(content), imageIds };
}

const CODEX_IMAGE_TAG_RE = /<image\b[^>]*\bpath=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>\s*\[image\]\s*<\/image>/gi;

function stripCodexImageTags(raw: string, onPath: (path: string) => void): string {
  return raw
    .replace(CODEX_IMAGE_TAG_RE, (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
      const path = decodeXmlEntities(doubleQuoted ?? singleQuoted ?? bare ?? "");
      if (path) onPath(path);
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function storeImagePathIfAllowed(imagePath: string): string | null {
  if (!isAllowedImagePath(imagePath) || !existsSync(imagePath)) return null;
  const mimeType = mimeTypeForImagePath(imagePath);
  if (!mimeType) return null;
  try {
    const buffer = readFileSync(imagePath);
    return storeBase64Image(buffer.toString("base64"), mimeType);
  } catch {
    return null;
  }
}

function isAllowedImagePath(imagePath: string): boolean {
  const resolved = resolve(imagePath);
  const imagesDir = resolve(join(DATA_DIR, "images"));
  return resolved.startsWith(`${imagesDir}/`) || resolved.startsWith("/tmp/callboard-codex-image-");
}

function mimeTypeForImagePath(imagePath: string): string | null {
  switch (extname(imagePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

function storeDataUriImage(imageUrl: string): string | null {
  const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const [, mimeType, base64Data] = match;
  if (!mimeType || !base64Data) return null;
  return storeBase64Image(base64Data, mimeType);
}

/**
 * Best-effort extraction of displayable text from the content shapes the rollout
 * uses: a plain string, an array of `{ type, text }` content blocks, or an
 * object with `.text`. Mirrors the OR parser's `extractTextContent`.
 */
export function extractText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (!block || typeof block !== "object") return "";
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") return b.text;
        if (b.type === "input_image" || b.type === "image" || b.type === "local_image") return "[image]";
        return "";
      })
      .filter((s) => s.length > 0)
      .join("\n");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
  }
  try {
    const json = JSON.stringify(content);
    return json === undefined ? String(content) : json;
  } catch {
    return String(content);
  }
}

/**
 * Read the first real user prompt out of a rollout — the chat-list preview.
 * Skips the synthetic lead messages the same way {@link parseCodexRollout}
 * does, returning the first genuine `user` message's text.
 */
export function readFirstUserPrompt(filePath: string): string | null {
  const meta = readCodexSessionMeta(filePath);
  if (meta?.nativeAgent) return meta.nativeAgent.nickname || meta.nativeAgent.agentPath || null;
  return (
    scanRolloutLines(filePath, (line) => {
      if (line.type !== "response_item") return undefined;
      const p = line.payload;
      if (!p || p.type !== "message" || p.role !== "user") return undefined;
      const { text: content } = extractTextAndImages(p.content);
      if (!content) return undefined;
      const head = content.trimStart().toLowerCase();
      if (SYNTHETIC_MESSAGE_PREFIXES.some((pre) => head.startsWith(pre))) return undefined;
      return content;
    }) ?? null
  );
}
