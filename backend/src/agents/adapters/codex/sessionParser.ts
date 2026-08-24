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
 *      The **first two messages are synthetic** (a `developer`
 *      "<permissions instructions>" and a `user` "<environment_context>") and are
 *      filtered out — the real user prompt is the next `user` message.
 *    - `"function_call"` / `"custom_tool_call"` → `tool_use`
 *      (`commandExecution`/`fileChange`/`mcpToolCall` all serialize through these
 *      Responses-API item shapes in the rollout).
 *    - `"function_call_output"` / `"custom_tool_call_output"` → `tool_result`.
 *    - `"reasoning"` → `thinking`.
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

const log = createLogger("codex-session-parser");

/**
 * The Codex CLI version this parser was written against (spike §1). The rollout
 * format is undocumented and version-dependent; when a rollout's
 * `session_meta.cli_version` differs we log once so a future format drift is
 * diagnosable rather than silently mis-parsed (spike risk #4).
 */
export const EXPECTED_CODEX_CLI_VERSION = "0.146.0";

/** Synthetic lead messages the Codex CLI injects ahead of the real transcript. */
const SYNTHETIC_MESSAGE_PREFIXES = ["<permissions", "<environment_context", "<user_instructions"];

let warnedVersionDrift = false;

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

interface SessionMeta {
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
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as RolloutLine);
    } catch {
      /* skip a torn / partially-written line */
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

/** Read up to `maxBytes` from the front of a file; `null` when unreadable. */
function readHead(filePath: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString("utf-8", 0, bytes);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** What {@link scanFlatHead} found: the leading scalars, and where they stopped. */
interface FlatHead {
  /** Members appearing before the object's first nested object/array value. */
  scalars: Record<string, unknown>;
  /** The key whose value is that first nested value, when there is one. */
  nestedKey?: string;
  /** Index of the `{` / `[` that opens it. */
  nestedStart?: number;
}

/**
 * Read the *leading scalar members* of the JSON object starting at `open`,
 * without parsing whatever comes after the first nested value.
 *
 * Why this exists: a rollout's `session_meta` payload ends with
 * `base_instructions.text` — the agent's entire system prompt. On a real device
 * that makes line 1 average **234 KB**, while the four fields discovery wants
 * (`id`, `cwd`, `timestamp`, `cli_version`) live in its first ~250 bytes. So
 * reading only the head of the *file* isn't enough; the expensive part is
 * `JSON.parse` on a quarter-megabyte line, once per rollout, on every
 * chat-list request.
 *
 * This walks the raw text with a string-aware scanner, stops at the first `{`
 * or `[`, and hands the flat prefix it collected to the real `JSON.parse` —
 * so the values are parsed by the parser, not by a regex. It is an accelerator,
 * never a second parser: anything it doesn't recognise returns `null` and the
 * caller falls back to parsing the line in full.
 */
function scanFlatHead(raw: string, open: number): FlatHead | null {
  if (raw[open] !== "{") return null;
  let inString = false;
  let escaped = false;
  /** Index of the comma closing the last complete member. */
  let lastComma = -1;
  /** Raw (still-escaped) text of the most recently read key. */
  let lastKey: string | null = null;
  let stringStart = -1;
  /** The next string to complete is a key, not a value. */
  let expectKey = true;

  for (let i = open + 1; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        if (expectKey) {
          lastKey = raw.slice(stringStart, i);
          expectKey = false;
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i + 1;
      continue;
    }
    if (ch === ",") {
      lastComma = i;
      expectKey = true;
      continue;
    }
    if (ch === "}") {
      // Wholly flat object — no nested value to stop at.
      const scalars = parseObject(raw.slice(open, i + 1));
      return scalars ? { scalars } : null;
    }
    if (ch === "{" || ch === "[") {
      // A nested value starts here. Everything up to the comma that closed the
      // previous member is a complete flat object once we re-close the brace.
      if (lastComma < 0 || lastKey === null) return null;
      const scalars = parseObject(raw.slice(open, lastComma) + "}");
      if (!scalars) return null;
      // `lastKey` is the raw, still-escaped text between the key's quotes;
      // round-tripping it through the parser is how it gets unescaped.
      const key = Object.keys(parseObject(`{"${lastKey}":0}`) ?? {})[0];
      return { scalars, ...(key !== undefined && { nestedKey: key }), nestedStart: i };
    }
  }
  return null; // ran off the end of the head — caller falls back
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Bytes of a rollout to read when trying the fast path. Comfortably larger than
 * any observed `session_meta` scalar prefix (~250 bytes) with room for the
 * outer wrapper; a rollout that doesn't yield its meta within this falls back
 * to the full scan.
 */
const META_HEAD_BYTES = 8192;

/** The `session_meta.payload` members {@link buildSessionMeta} reads. */
const WANTED_META_KEYS = ["id", "cwd", "timestamp", "cli_version"] as const;

/**
 * Fast path for {@link readCodexSessionMeta}: pull the meta out of the file's
 * first 8 KB using {@link scanFlatHead}. Returns `undefined` (not `null`) when
 * the head isn't recognisable, which means "fall back", as distinct from the
 * `null` that means "this rollout has no session_meta".
 */
function readSessionMetaFromHead(filePath: string): SessionMeta | undefined {
  const head = readHead(filePath, META_HEAD_BYTES);
  if (!head) return undefined;
  const open = head.indexOf("{");
  if (open < 0) return undefined;

  const outer = scanFlatHead(head, open);
  // `session_meta` is line 1 of a rollout. If line 1 is something else, this
  // isn't a shape the fast path can rule on — let the full scan decide.
  if (!outer || outer.scalars.type !== "session_meta") return undefined;
  if (outer.nestedKey !== "payload" || outer.nestedStart === undefined) return undefined;

  const payload = scanFlatHead(head, outer.nestedStart);
  if (!payload) return undefined;
  // When the scan stopped at a nested value, `scalars` is a PREFIX of the
  // payload — everything after that value is unread. Answering from a prefix
  // that is missing a field we want would not look like a failure: the shape is
  // still perfectly recognisable, so the fast path would confidently report
  // `cwd: ""` for every rollout the day a Codex release emits its `git` object
  // (or any other new nested member) ahead of `cwd`. Downstream that hides
  // ignored folders' sessions, collapses every Codex chat into one empty-path
  // sidebar row, and — because `cli_version` is lost the same way — silences
  // `checkCliVersion`, the drift alarm that exists to warn about exactly this.
  // So a partial prefix is not an answer; it's a fall-back to the full scan.
  //
  // A wholly flat payload (no `nestedKey`) went through `JSON.parse` entire, so
  // there is nothing unread and no guard to apply. The remaining prefix-shaped
  // gap is a key duplicated on BOTH sides of the nested value, where the scan
  // keeps the first and `JSON.parse` would keep the last — no JSON serialiser
  // emits duplicate keys, and the scan is an accelerator for files Codex wrote.
  if (payload.nestedKey !== undefined && !WANTED_META_KEYS.every((key) => key in payload.scalars)) return undefined;
  return buildSessionMeta(payload.scalars);
}

function buildSessionMeta(payload: Record<string, unknown>): SessionMeta {
  const meta: SessionMeta = {};
  if (typeof payload.id === "string") meta.id = payload.id;
  if (typeof payload.cwd === "string") meta.cwd = payload.cwd;
  if (typeof payload.timestamp === "string") meta.timestamp = payload.timestamp;
  if (typeof payload.cli_version === "string") meta.cliVersion = payload.cli_version;
  checkCliVersion(meta.cliVersion);
  return meta;
}

/**
 * Memo for {@link readCodexSessionMeta}, keyed by path and invalidated by the
 * file's `mtimeMs`/`size`.
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
const metaCache = new Map<string, { mtimeMs: number; size: number; meta: SessionMeta | null }>();
/** Key of the newest insertion — the one eviction takes when the memo is full. */
let metaCacheNewest: string | null = null;

/** Drop every memoized `session_meta`. Test seam — production never needs it. */
export function clearCodexSessionMetaCache(): void {
  metaCache.clear();
  metaCacheNewest = null;
}

/**
 * Read just the `session_meta` (first matching line) of a rollout. Used by the
 * provider for discovery (folder, sort timestamp) and id resolution without
 * parsing the whole transcript.
 *
 * Memoized per file version — discovery asks this of every rollout on every
 * chat-list request, and the answer only changes when the file does.
 */
export function readCodexSessionMeta(filePath: string): SessionMeta | null {
  let mtimeMs = -1;
  let size = -1;
  try {
    const st = statSync(filePath);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    // Unreadable/missing: answer "no meta", the same thing the scan would have
    // answered before there was a cache, without memoizing anything for a file
    // we couldn't stat — so the answer isn't pinned once the file appears.
    return null;
  }

  const cached = metaCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.meta;

  const meta =
    readSessionMetaFromHead(filePath) ??
    scanRolloutLines(filePath, (line) => {
      if (line.type !== "session_meta") return undefined;
      return buildSessionMeta(line.payload ?? {});
    }) ??
    null;

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
  metaCache.set(filePath, { mtimeMs, size, meta });
  metaCacheNewest = filePath;
  return meta;
}

/** Warn once if a rollout was written by a Codex CLI version we don't target. */
function checkCliVersion(cliVersion: string | undefined): void {
  if (warnedVersionDrift || !cliVersion || cliVersion === EXPECTED_CODEX_CLI_VERSION) return;
  warnedVersionDrift = true;
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
  const lines = readRolloutLines(filePath);
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
        toolName: name,
        content,
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
  const { text: content, imageIds } = extractTextAndImages(payload.content);
  if (!content && imageIds.length === 0) return null;

  // Drop the CLI's synthetic lead messages (permissions instructions /
  // environment context / injected user instructions) — they aren't part of
  // the user-visible conversation. Detected by their angle-bracket tag prefix
  // so the filter is position-independent and survives reordering.
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
