/**
 * The summary a per-message compression replaces part of a chat with.
 *
 * Generated on the chat's own harness and model ({@link runChatModelCompletion})
 * and shown to the user, who may edit it before it is committed — so this
 * module only produces text; nothing here writes a session.
 *
 * Long spans are summarised in chunks: the span's transcript is cut on turn
 * boundaries into pieces of at most {@link MAX_CHUNK_CHARS}, each piece is
 * summarised on its own, and the partial summaries are merged by one more call.
 * The transcript is already bounded per tool call (the handoff projection
 * truncates every tool input/result), so a chunk is ~40k tokens at most —
 * comfortably inside every supported model's window together with the prompt.
 */
import type { ParsedMessage } from "shared/types/index.js";
import type { EffortLevel } from "shared/types/index.js";
import type { InternalProviderKind } from "../agents/ports/AgentProvider.js";
import { compressionSpans, hasConversation, transcriptBlocksForSummary, type CompressDirection } from "../agents/compression.js";
import { runChatModelCompletion } from "./chat-model-completion.js";

/** Per-call transcript budget, in characters (~4 chars per token). */
export const MAX_CHUNK_CHARS = 160_000;
/** Beyond this many chunks a span is refused rather than summarised for minutes. */
export const MAX_CHUNKS = 16;

export class CompressionInputError extends Error {}

const GUIDANCE: Record<CompressDirection, string> = {
  before: [
    "You are compressing the EARLIER part of a conversation between a user and an AI coding assistant.",
    "The assistant will continue the conversation from the messages that follow this part, which are kept verbatim; your summary replaces everything below.",
    "Write a dense, factual summary the assistant can rely on in place of these messages. Keep:",
    "- the user's goals, requests and constraints, and any preferences they stated;",
    "- decisions made and why, and approaches tried and rejected;",
    "- concrete facts: file paths, function names, commands, errors, URLs, identifiers;",
    "- the state of the work at the end of this part: what is done, what is in progress, what is still open.",
  ].join("\n"),
  after: [
    "You are compressing the LATER part of a conversation between a user and an AI coding assistant.",
    "Everything before this part is kept verbatim; the assistant will continue from the end of it with your summary in place of the messages below.",
    "Write a dense, factual summary of what happened in this part. Keep:",
    "- what the user asked for and what the assistant did — files changed, commands run, results, errors;",
    "- decisions made and why, and approaches tried and rejected;",
    "- concrete facts: file paths, function names, identifiers;",
    "- the state the work was left in: what is done, what is in progress, what is still open.",
  ].join("\n"),
};

const FORMAT = [
  "Answer with the summary only — no preamble, no closing remarks. Use short headings or bullet points where they help.",
  "Do not call any tools; everything you need is in the transcript.",
].join("\n");

function summaryPrompt(direction: CompressDirection, transcript: string, part?: { index: number; total: number }): string {
  return [
    GUIDANCE[direction],
    ...(part ? [`This is part ${part.index} of ${part.total} of that span; summarise this part only.`] : []),
    FORMAT,
    "",
    "<transcript>",
    transcript,
    "</transcript>",
  ].join("\n");
}

function mergePrompt(direction: CompressDirection, partials: string[]): string {
  return [
    GUIDANCE[direction],
    "The span was too long to read at once, so it was summarised in consecutive parts. Merge the part summaries below into one summary of the whole span, in order, dropping repetition but no facts.",
    FORMAT,
    "",
    ...partials.map((p, i) => `<part index="${i + 1}">\n${p}\n</part>`),
  ].join("\n");
}

/** Cut transcript blocks into chunks of at most `max` characters, never splitting a block unless it alone exceeds `max`. */
export function chunkBlocks(blocks: string[], max = MAX_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const piece = block.length > max ? `${block.slice(0, max)}\n… [truncated for the summary]` : block;
    if (current && current.length + piece.length + 2 > max) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface SummariseOptions {
  messages: ParsedMessage[];
  timestamp: string;
  direction: CompressDirection;
  provider: InternalProviderKind;
  model?: string;
  effort?: EffortLevel;
  signal?: AbortSignal;
}

/**
 * Check a compression has something on both sides of its cutoff. Throws
 * {@link CompressionInputError} with a user-facing reason otherwise.
 */
export function assertCompressible(messages: ParsedMessage[], timestamp: string, direction: CompressDirection): { summarised: ParsedMessage[]; kept: ParsedMessage[] } {
  const spans = compressionSpans(messages, timestamp, direction);
  if (!hasConversation(spans.summarised)) {
    throw new CompressionInputError(direction === "before" ? "There are no earlier messages to compress" : "There are no later messages to compress");
  }
  if (!hasConversation(spans.kept)) throw new CompressionInputError("No messages found at that point in the conversation");
  return spans;
}

/** Generate the summary for a compression. */
export async function summariseForCompression(opts: SummariseOptions): Promise<{ summary: string; chunks: number }> {
  const { summarised } = assertCompressible(opts.messages, opts.timestamp, opts.direction);
  const chunks = chunkBlocks(transcriptBlocksForSummary(summarised));
  if (chunks.length > MAX_CHUNKS) {
    throw new CompressionInputError(`That part of the conversation is too long to summarise (${chunks.length} chunks; the limit is ${MAX_CHUNKS}). Pick a cutoff closer to the end.`);
  }
  const run = (prompt: string) => runChatModelCompletion({ provider: opts.provider, model: opts.model, effort: opts.effort, prompt, signal: opts.signal });

  if (chunks.length === 1) return { summary: await run(summaryPrompt(opts.direction, chunks[0]!)), chunks: 1 };
  // Sequential on purpose: each call is a full model run on the user's
  // account, and fanning out N of them at once is a burst of spend and rate
  // limit for a dialog the user is waiting on anyway.
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    partials.push(await run(summaryPrompt(opts.direction, chunks[i]!, { index: i + 1, total: chunks.length })));
  }
  return { summary: await run(mergePrompt(opts.direction, partials)), chunks: chunks.length };
}
