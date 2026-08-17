/**
 * Reading pi's own session files — the read half of Decision 1.
 *
 * Callboard does **not** keep a shadow transcript for pi, unlike Cline. The
 * plan's reasoning holds up: `parseSessionEntries(content)` is synchronous and
 * takes a string, which is exactly the shape `SessionProvider`'s synchronous
 * methods need, and the format is versioned with a migrator
 * (`CURRENT_SESSION_VERSION = 3`). One store, no drift between what pi resumes
 * from and what callboard renders.
 *
 * ## `SessionManager.list()` is async, so it is not used
 *
 * The obvious API for discovery is `SessionManager.list(cwd, sessionDir)`, which
 * returns `SessionInfo[]` complete with `firstMessage` and `allMessagesText`.
 * It returns a **`Promise`**, and every `SessionProvider` method is synchronous.
 * There is no awaiting it from inside `discoverSessions()`.
 *
 * So this module re-derives the same two fields from the sync primitives:
 * `readFileSync` + `parseSessionEntries`. {@link derivePreview} is
 * `SessionInfo.firstMessage`; {@link deriveSearchText} is `allMessagesText`.
 * The cost is real and is discussed on {@link deriveSearchText}.
 *
 * ## Entry types this must survive
 *
 * A pi session is an append-only **tree**: every entry carries `id` and
 * `parentId`, and the live conversation is the path from the current leaf back
 * to the root. Nine entry types exist (`message`, `thinking_level_change`,
 * `model_change`, `compaction`, `branch_summary`, `custom`, `custom_message`,
 * `label`, `session_info`), and pi injects several of its own into any session
 * callboard writes — the spike watched `model_change` and
 * `thinking_level_change` appear in a hand-written file after one resume. A
 * parser that switches exhaustively on today's list will break on a pi that adds
 * a tenth, so unknown types are skipped rather than treated as an error.
 *
 * @see plans/pi-adapter.md (Decision 1)
 * @see plans/pi-spike-findings.md (§5 — the format, round-tripped)
 */
import { readFileSync, readdirSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { parseSessionEntries, type FileEntry, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import type { ParsedMessage } from "shared/types/index.js";
import { createLogger } from "../../../utils/logger.js";
import { resolvePiSessionsRoot } from "./paths.js";

const log = createLogger("pi-session-parser");

/** One session file on disk, as discovery sees it. */
export interface PiSessionFile {
  sessionId: string;
  filePath: string;
  stat: Stats;
}

/** Header + entries of one session file. */
export interface PiSessionContents {
  header: SessionHeader | null;
  entries: SessionEntry[];
}

/**
 * Read and parse one session file.
 *
 * Never throws: a session directory can contain a half-written file (pi flushes
 * lazily — nothing lands on disk until the first assistant message), a file from
 * a future version, or plain garbage. A chat list that 500s because one file is
 * malformed is worse than one that omits it.
 */
export function readPiSession(filePath: string): PiSessionContents {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    log.warn(`Could not read pi session ${filePath}: ${(err as Error).message}`);
    return { header: null, entries: [] };
  }

  let parsed: FileEntry[];
  try {
    parsed = parseSessionEntries(raw);
  } catch (err) {
    log.warn(`Could not parse pi session ${filePath}: ${(err as Error).message}`);
    return { header: null, entries: [] };
  }

  const header = (parsed.find((e) => e.type === "session") as SessionHeader | undefined) ?? null;
  const entries = parsed.filter((e): e is SessionEntry => e.type !== "session");
  return { header, entries };
}

/** The `cwd` a session was started in, or `""` when the header is missing. */
export function readPiSessionCwd(filePath: string): string {
  return readPiSession(filePath).header?.cwd ?? "";
}

/**
 * Every session file under the root, newest first.
 *
 * Reads **only the directory**, never a file: the session id comes from the
 * filename (`<ISO>_<id>.jsonl`) and the timestamps from `stat`. `discoverSessions`
 * is called on every chat-list render, so opening N files here would be the
 * difference between a listing and a scan.
 */
export function listPiSessions(root: string = resolvePiSessionsRoot()): PiSessionFile[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    // No pi chats yet — an absent directory is the normal state, not an error.
    return [];
  }

  const files: PiSessionFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = join(root, name);
    let stat: Stats;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files.push({ sessionId: sessionIdFromFileName(name), filePath, stat });
  }

  return files.sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());
}

/**
 * `<ISO>_<id>.jsonl` → `<id>`; `<id>.jsonl` → `<id>`.
 *
 * Splits on the **first** underscore, because a callboard chat id is a UUID and
 * pi ids are hex — neither contains one, but a user-chosen id might, and the
 * timestamp prefix never does.
 */
export function sessionIdFromFileName(name: string): string {
  const base = name.replace(/\.jsonl$/, "");
  const underscore = base.indexOf("_");
  return underscore === -1 ? base : base.slice(underscore + 1);
}

// ── Projection into callboard's neutral format ──────────────────────

/**
 * Project a session file into {@link ParsedMessage}s.
 *
 * Entries are taken in **file order** rather than by walking the tree from the
 * leaf. That is a deliberate divergence from `buildSessionContext()`, which pi
 * uses to build what the *model* sees: it follows one branch and drops entries
 * that a compaction summarized away. Callboard is rendering a *transcript* —
 * everything that happened, including branches the user navigated away from and
 * turns that were later compacted. Hiding them would make the UI disagree with
 * the file the user can open.
 */
export function parsePiSession(filePath: string): ParsedMessage[] {
  const { header, entries } = readPiSession(filePath);
  const out: ParsedMessage[] = [];
  // Namespaces {@link entryGenerationKey}. A chat's messages are the
  // concatenation of *several* session files (`PiSessionProvider.getMessages`
  // walks every session id on the chat, and a fork adds one), and pi's entry ids
  // are only unique within a file.
  const sessionId = header?.id ?? filePath;
  for (const entry of entries) out.push(...projectEntry(entry, sessionId));
  return out;
}

function projectEntry(entry: SessionEntry, sessionId: string): ParsedMessage[] {
  const timestamp = entry.timestamp;

  switch (entry.type) {
    case "message":
      return projectMessage(entry.message as PiAgentMessage, timestamp, entryGenerationKey(sessionId, entry.id));

    // Both carry the usage of the LLM call that *wrote the summary* —
    // `CompactionEntry.usage` / `BranchSummaryEntry.usage`, documented in pi as
    // "Usage from the LLM call(s) that generated this summary". Those were real
    // billed calls: a chat that auto-compacted three times spent three times,
    // and dropping them made "Total cost" quietly short in the one place a user
    // opens to find out what a chat cost. They are projected onto the boundary
    // marker itself rather than a synthetic assistant message, because the
    // summary is not something the assistant said to the user.
    case "compaction":
      // The boundary itself, so the UI can show where history was summarized —
      // the same shape `AgentEvent.compaction_boundary` carries at run time.
      return [
        {
          role: "system",
          type: "system",
          subtype: "compact_boundary",
          content: entry.summary ?? "",
          timestamp,
          ...summaryMetrics(entry.usage, entryGenerationKey(sessionId, entry.id)),
        },
      ];

    case "branch_summary":
      return [
        {
          role: "system",
          type: "system",
          subtype: "compact_boundary",
          content: entry.summary ?? "",
          timestamp,
          ...summaryMetrics(entry.usage, entryGenerationKey(sessionId, entry.id)),
        },
      ];

    case "custom_message": {
      // Extension-injected context. `display: false` means pi hides it in its own
      // UI; callboard honours that rather than surfacing plumbing.
      if (!entry.display) return [];
      const text = extractText(entry.content);
      return text ? [{ role: "user", type: "text", content: text, timestamp }] : [];
    }

    // Tree/plumbing entries with nothing to render. Listed rather than left to
    // the default so adding a case is a deliberate act.
    case "thinking_level_change":
    case "model_change":
    case "custom":
    case "label":
    case "session_info":
      return [];

    default:
      // A pi that adds a tenth entry type renders nothing rather than throwing.
      return [];
  }
}

/** The message shapes that appear inside a `message` entry. */
interface PiAgentMessage {
  role?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  model?: string;
  customType?: string;
  display?: boolean;
  /**
   * `AssistantMessage.responseModel` — the model the provider actually served.
   *
   * Preferred over {@link PiAgentMessage.model}, which is the alias the *request*
   * asked for. The Model column and its filter are a diagnostic, and "what I
   * asked for" and "what answered" differ exactly when a user most needs to
   * know — a provider silently substituting, or an alias resolving elsewhere
   * than expected. Falls back to `model` for an entry written before pi recorded
   * the served name.
   */
  responseModel?: string;
  /** `AssistantMessage.usage` — see {@link projectUsage}. */
  usage?: PiSessionUsage;
  /** `AssistantMessage.stopReason` — see {@link normalizeStopReason}. */
  stopReason?: string;
  /** The provider's own response id, when the provider returned one. */
  responseId?: string;
}

/**
 * pi's `Usage`, as it sits in the session file.
 *
 * Mirrors `@earendil-works/pi-ai`'s `Usage` rather than importing it: this
 * module reads *files on disk*, which may have been written by a different pi
 * version than the one currently installed, so every field is optional here even
 * where the SDK type requires it.
 */
interface PiSessionUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  /** A **breakdown object** (`{input, output, cacheRead, cacheWrite, total}`), not a scalar. */
  cost?: { total?: number } | number;
}

/**
 * The responses debug panel's row-grouping identity for one pi entry.
 *
 * A pi session entry IS one generation: one `AssistantMessage` per API call,
 * appended with its own tree-node `id`. So unlike ACP and Cline this is not a
 * positional counter — it is the file's own identifier for the generation, and
 * the panel's rows land one-per-API-call rather than one-per-turn.
 */
export function entryGenerationKey(sessionId: string, entryId: string): string {
  return `pi:${sessionId}/${entryId}`;
}

/**
 * pi's `StopReason` → the vocabulary `ParsedMessage.stopReason` is documented in.
 *
 * pi reports a **model** stop reason — the same closed concept Anthropic's
 * `stop_reason` names, spelled differently — so the three that correspond are
 * renamed rather than passed through. That is a translation, not an
 * interpretation: `stop`/`length`/`toolUse` and `end_turn`/`max_tokens`/
 * `tool_use` are the same three facts, and leaving pi's spelling in place would
 * split the panel's Stop filter and colour-coding across engines for no reason.
 *
 *     pi          →  ParsedMessage.stopReason
 *     "stop"      →  "end_turn"
 *     "length"    →  "max_tokens"
 *     "toolUse"   →  "tool_use"
 *     "error"     →  "error"      (no Anthropic counterpart — verbatim)
 *     "aborted"   →  "aborted"    (no Anthropic counterpart — verbatim)
 *     "pending"   →  "pending"    (a partial write; verbatim, and honest)
 *
 * Anything pi adds later falls through verbatim rather than being guessed at.
 *
 * Contrast Cline, whose finish reason is deliberately NOT translated: it reports
 * why the agent *loop* ended, which is a different fact from why the model
 * stopped. pi's is the model's.
 */
export function normalizeStopReason(stopReason: string): string {
  switch (stopReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "toolUse":
      return "tool_use";
    default:
      return stopReason;
  }
}

/**
 * pi's `Usage` → `ParsedMessage.usage`, or undefined when the entry has none.
 *
 * Cache counts are surfaced as their own columns rather than folded into
 * `input_tokens`: pi bills them separately, `cost.total` already accounts for
 * them, and inflating the input figure would make it disagree with the cost
 * beside it. `reasoning` is a **subset** of `output` per pi's own doc-comment,
 * so it rides along as a breakdown and is never added on.
 *
 * A field pi did not write stays undefined rather than defaulting to 0 — the
 * debug panel renders the two differently, and a manufactured zero in a
 * diagnostics table reads as a measurement.
 */
function projectUsage(usage: PiSessionUsage | undefined): ParsedMessage["usage"] | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const projected: NonNullable<ParsedMessage["usage"]> = {};
  const input = count(usage.input);
  const output = count(usage.output);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  const reasoning = count(usage.reasoning);
  if (input !== undefined) projected.input_tokens = input;
  if (output !== undefined) projected.output_tokens = output;
  if (cacheRead !== undefined) projected.cache_read_input_tokens = cacheRead;
  if (cacheWrite !== undefined) projected.cache_creation_input_tokens = cacheWrite;
  if (reasoning !== undefined) projected.reasoning_tokens = reasoning;
  // An entry whose `usage` object held nothing usable is no usage at all: the
  // panel's row filter is `usage` being present, and an empty object would
  // conjure a row of dashes for a generation we know nothing about.
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * The panel-visible metrics of a compaction / branch-summary entry.
 *
 * Same projection as a generation's, minus the things a summary call has none
 * of: pi records no `stopReason`, `responseId` or model for these, so those
 * columns stay blank rather than borrowing the chat's. `generationKey` is the
 * entry's own id, exactly as for a generation — a compaction *is* one API call.
 */
function summaryMetrics(usage: PiSessionUsage | undefined, generationKey: string): Partial<ParsedMessage> {
  const projected = projectUsage(usage);
  const costUsd = projectCost(usage);
  if (!projected && costUsd === undefined) return {};
  return {
    ...(projected && { usage: projected }),
    ...(costUsd !== undefined && { costUsd }),
    generationKey,
  };
}

/** pi's `cost` breakdown → a scalar USD figure, when it has one. */
function projectCost(usage: PiSessionUsage | undefined): number | undefined {
  const cost = typeof usage?.cost === "number" ? usage.cost : usage?.cost?.total;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}

function projectMessage(message: PiAgentMessage, timestamp: string, generationKey: string): ParsedMessage[] {
  switch (message?.role) {
    case "user": {
      const text = extractText(message.content);
      return text ? [{ role: "user", type: "text", content: text, timestamp }] : [];
    }

    case "assistant": {
      const out: ParsedMessage[] = [];
      // Identity, on every block; measurements, on exactly one.
      //
      // Populating these at all is what makes pi visible in the responses debug
      // panel: its whole row filter is `role === "assistant" && usage`, and
      // before this the parser projected nothing but text, so a pi chat's panel
      // was empty — not sparse, empty.
      //
      // But the panel is not the only reader. `MessageBubble` renders
      // `MessageMetadata` for thinking, tool_use *and* text blocks, and unlike
      // the panel it does no grouping — so a figure stamped on every block is
      // printed once per bubble. An entry with `cost.total = 0.0626` producing
      // thinking + prose + two tool calls showed `Cost: $0.0626` four times, and
      // a user adding up a chat's per-message costs got ~4× the real spend.
      // (The Claude Code parser's `meta`, cited as precedent for spreading,
      // carries no `costUsd` — the Agent SDK reports none — and both acp and
      // cline stamp theirs on exactly one message. There was no precedent.)
      //
      // So `model` and `generationKey` ride on every block, being identity, and
      // `usage` / `costUsd` / `stopReason` / `requestId` go on the entry's
      // **last** block only, being measurements of the call as a whole. The
      // panel's canonical-entry picker prefers the block carrying `stopReason`,
      // so it still lands on the row that has the numbers.
      const identity = {
        // What answered, not what was asked for — see {@link PiAgentMessage.responseModel}.
        ...((message.responseModel || message.model) && { model: message.responseModel || message.model }),
        generationKey,
      };
      const usage = projectUsage(message.usage);
      const costUsd = projectCost(message.usage);
      const metrics = {
        ...(usage && { usage }),
        ...(costUsd !== undefined && { costUsd }),
        ...(message.stopReason && { stopReason: normalizeStopReason(message.stopReason) }),
        // The provider's own id — a real one, quotable to that provider's
        // support — when the provider returned one. Never synthesized.
        ...(message.responseId && { requestId: message.responseId }),
      };
      // Order within the message is preserved: reasoning, prose and tool calls
      // interleave, and re-grouping them would misrepresent the turn.
      for (const block of asBlocks(message.content)) {
        const type = (block as { type?: string }).type;
        if (type === "thinking") {
          const thinking = String((block as { thinking?: unknown }).thinking ?? "");
          if (thinking) out.push({ role: "assistant", type: "thinking", content: thinking, timestamp, ...identity });
        } else if (type === "text") {
          const text = String((block as { text?: unknown }).text ?? "");
          if (text) out.push({ role: "assistant", type: "text", content: text, timestamp, ...identity });
        } else if (type === "toolCall") {
          const call = block as { id?: string; name?: string; arguments?: unknown };
          out.push({
            role: "assistant",
            type: "tool_use",
            content: renderJson(call.arguments),
            toolName: call.name || "tool",
            ...(call.id && { toolUseId: call.id }),
            timestamp,
            ...identity,
          });
        }
      }
      // An entry with no renderable block (an empty reply, a `pending` partial)
      // has nowhere to put them and produces no row — unchanged, and correct:
      // an empty bubble minted to carry a number would be worse than the gap.
      if (out.length > 0) Object.assign(out[out.length - 1], metrics);
      return out;
    }

    case "toolResult":
      return [
        {
          // Claude-shaped convention the other parsers follow: a tool result is
          // carried on a user-role message. `handoff.ts` depends on it.
          role: "user",
          type: "tool_result",
          content: extractText(message.content),
          ...(message.toolName && { toolName: message.toolName }),
          ...(message.toolCallId && { toolUseId: message.toolCallId }),
          ...(message.isError && { subtype: "error" }),
          timestamp,
        },
      ];

    default: {
      // `bashExecution`, `custom` and anything pi adds later. A user-run bash
      // command is real conversation content, so render its text if it has any.
      const text = extractText(message?.content);
      return text ? [{ role: "system", type: "system", content: text, timestamp }] : [];
    }
  }
}

function asBlocks(content: unknown): unknown[] {
  return Array.isArray(content) ? content : [];
}

/** Join the text blocks of a pi content value. Tolerates the bare-string form. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type?: string; text?: unknown } => !!b && typeof b === "object")
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("");
}

function renderJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── The two fields `SessionInfo` would have given us ────────────────

/**
 * First user message — `SessionInfo.firstMessage`, re-derived.
 *
 * Stops at the first match instead of projecting the whole file, so a preview of
 * a long session costs one parse and a short scan rather than a full projection.
 */
export function derivePreview(filePath: string): string | null {
  const { entries } = readPiSession(filePath);
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as PiAgentMessage;
    if (message?.role !== "user") continue;
    const text = extractText(message.content).trim();
    if (text) return text;
  }
  return null;
}

/**
 * All conversational text in one string — `SessionInfo.allMessagesText`,
 * re-derived, for `grep` in {@link SessionProvider.searchSessions}.
 *
 * **This is the expensive one, and it is worth being explicit about.** Unlike
 * discovery (a `readdir`) and resolution (a filename compare), grep genuinely has
 * to open and parse every candidate file. A pi session is JSONL with the full
 * text of every turn plus tool arguments and results, so a busy chat is
 * comfortably in the hundreds of KB. `searchSessions` already narrows by folder
 * and date *before* reaching for this — see `PiSessionProvider.searchSessions`,
 * where the ordering of the filters is load-bearing rather than incidental — so
 * the full cost is only paid by a grep with no other filter.
 *
 * Measured on this branch, not estimated: a **1.69 MB** session of **2,601
 * entries** costs **6.8 ms** through this function (5.6 ms of that is
 * `readFileSync` + `parseSessionEntries`). So an unscoped grep over a
 * 200-session directory of that size is **~1.4 s**.
 *
 * That is acceptable for today's volumes and would not be at ten times the
 * count. It is worth stating plainly rather than discovering later: search is
 * the one operation in this provider that is linear in *bytes on disk* rather
 * than in *number of chats*.
 *
 * `SessionInfo` would not have helped even if it were reachable —
 * `SessionManager.list()` reads and parses every file too, it just does it
 * behind a `Promise`. If this becomes a problem the answer is an index, not a
 * different pi API.
 */
export function deriveSearchText(filePath: string): string {
  const { entries } = readPiSession(filePath);
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      const text = extractText((entry.message as PiAgentMessage)?.content);
      if (text) parts.push(text);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      if (entry.summary) parts.push(entry.summary);
    }
  }
  return parts.join("\n");
}
