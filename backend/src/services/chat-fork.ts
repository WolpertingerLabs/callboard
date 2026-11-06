/**
 * The parts of "write a new session out of this chat's history" that the fork
 * route and the supersede routes (continue-from, compress) share: which
 * provider owns the source chat, the session write itself, and the metadata a
 * new chat inherits from the one it was made from.
 *
 * Route-specific decisions — the target harness of a handoff, the model and
 * effort checks, the title, and where the new chat sits in the tree — stay
 * with the callers.
 */
import type { SessionProvider } from "../agents/ports/SessionProvider.js";
import { getSessionProviders } from "../agents/factory.js";
import { isInternalProvider, isRetiredProvider, type InternalProviderKind } from "../agents/ports/AgentProvider.js";
import { buildHandoffTurns, flattenForHandoff, truncateAtCutoff, type HandoffTurn } from "../agents/handoff.js";
import { historyBeforePrompt } from "./chat-rerun.js";
import { buildCompressedTurns, type CompressDirection } from "../agents/compression.js";
import { readChatSessionMessages } from "../utils/chat-lookup.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { isHandoffPreambleText, isUserTurn, type ParsedMessage } from "shared/types/index.js";

export interface ForkSource {
  meta: Record<string, any>;
  providerKind: InternalProviderKind;
  provider: SessionProvider;
  /** Every session id the chat spans, its current one last. */
  sessionIds: string[];
}

export type ForkSourceResult = ({ ok: true } & ForkSource) | { ok: false; status: 400 | 409; error: string };

/**
 * Resolve the chat's own provider for reading/writing its history. `verb`
 * names the action in the refusal ("forked", "compressed").
 */
export function resolveForkSource(
  chat: { metadata?: string | null; session_id: string; _provider_resolution_error?: string },
  verb = "forked",
): ForkSourceResult {
  if (chat._provider_resolution_error) return { ok: false, status: 409, error: chat._provider_resolution_error };
  const meta: Record<string, any> = parseChatMetadata(chat.metadata);

  // Chats stamped with a removed harness are refused by name before the guard
  // below can silently call them claude-code chats — 155 records name the
  // OpenRouter one, and the fallback would send the fork looking for a session
  // log nothing can read. An explicit 400 beats a fork that appears to work.
  if (isRetiredProvider(meta.provider)) {
    return { ok: false, status: 400, error: `This chat ran on the OpenRouter agent harness, which has been removed. It cannot be ${verb}.` };
  }

  // The SOURCE kind comes off persisted metadata, so it is read with the
  // internal guard rather than the routable one: a kind that is implemented but
  // not yet offered must still be forkable out of.
  const providerKind: InternalProviderKind = isInternalProvider(meta.provider) ? meta.provider : "claude-code";
  const provider = getSessionProviders().find((p) => p.kind === providerKind);
  if (!provider) return { ok: false, status: 400, error: `This chat's provider does not support being ${verb}` };

  const sessionIds: string[] = Array.isArray(meta.session_ids) ? [...meta.session_ids] : [];
  if (!sessionIds.includes(chat.session_id)) sessionIds.push(chat.session_id);
  return { ok: true, meta, providerKind, provider, sessionIds };
}

/**
 * Write the forked session: the native log copy when source and target are the
 * same harness and it has one, otherwise the neutral turns projection seeded
 * into the target. Null when nothing falls at or before the cutoff. Throws
 * `UnsupportedForkError` when the target can be written neither way.
 *
 * With `before` (a user prompt's timestamp) the fork is everything strictly
 * before that prompt, cut by POSITION — `timestamp` is then ignored. A
 * timestamp cannot express "strictly before the prompt" in every log (the
 * Claude CLI stamps the lines after a prompt earlier than the prompt), so:
 * a provider with `forkSessionBefore` cuts at the prompt's line; one whose
 * `forkSession` drops every entry stamped after the cutoff (pi, Cline) is
 * forked one millisecond before the prompt, which drops the prompt's own
 * entry by construction; the seeded path slices the parsed history at the
 * prompt's index.
 */
export function writeForkedSession(opts: {
  chat: { folder: string; metadata?: string | null; session_id?: string };
  source: ForkSource;
  targetKind: InternalProviderKind;
  targetProvider: SessionProvider;
  timestamp: string;
  newSessionId: string;
  /** The prompt to cut before: its timestamp, and its text to tell it from another user line in the same millisecond. */
  before?: { timestamp: string; text?: string };
}): { logPath: string } | null {
  const { chat, source, targetKind, targetProvider, timestamp, newSessionId, before } = opts;
  const isHandoff = targetKind !== source.providerKind;
  if (!isHandoff && before && source.provider.forkSessionBefore) {
    return source.provider.forkSessionBefore(source.sessionIds, before, newSessionId);
  }
  if (!isHandoff && source.provider.forkSession) {
    if (before) return source.provider.forkSession(source.sessionIds, new Date(new Date(before.timestamp).getTime() - 1).toISOString(), newSessionId);
    // Same harness: copy the native session log. Preserves everything the
    // engine wrote — real tool_use blocks, reasoning, ids — which the
    // neutral turn projection below necessarily drops.
    return source.provider.forkSession(source.sessionIds, timestamp, newSessionId);
  }
  if (targetProvider.seedSession) {
    // Cross-harness (or a same-harness provider with no native fork): read
    // the history through the SOURCE provider's parser, then write it into
    // the TARGET's native format as conversational turns.
    const messages = readChatSessionMessages(chat, source.sessionIds);
    const history = before ? historyBeforePrompt(messages, before.timestamp) : truncateAtCutoff(messages, timestamp);
    const turns = seededTurns(history, source.providerKind, targetKind);
    return turns.length > 0 ? targetProvider.seedSession(turns, { folder: chat.folder, newSessionId }) : null;
  }
  throw new UnsupportedForkError();
}

/**
 * The turns a seeded fork is written from. A handoff gets the preamble
 * exchange that tells the target where the history came from. A same-harness
 * fork of a history that ALREADY opens with one — a seeded chat forked,
 * continued or rerun again — keeps that one instead of stacking another on top
 * (each rerun of a Codex chat used to add a preamble pair). Its provenance
 * (the harness the conversation really came from) is the accurate one, too.
 */
function seededTurns(history: ParsedMessage[], from: InternalProviderKind, to: InternalProviderKind): HandoffTurn[] {
  const firstUser = history.find(isUserTurn);
  if (from === to && firstUser && isHandoffPreambleText(firstUser.content)) return flattenForHandoff(history).turns;
  return buildHandoffTurns(history, from, to);
}

export class UnsupportedForkError extends Error {
  constructor() {
    super("The target provider can neither fork nor seed a session");
  }
}

/**
 * Write a compressed copy of the chat's session in its own harness: natively
 * where the provider has a writer, otherwise as flattened turns seeded back in.
 * Null when either side of the cutoff is empty. Throws `UnsupportedForkError`
 * when the provider can be written neither way.
 */
export function writeCompressedSession(opts: {
  chat: { folder: string; metadata?: string | null; session_id?: string };
  source: ForkSource;
  timestamp: string;
  direction: CompressDirection;
  summary: string;
  newSessionId: string;
}): { logPath: string } | null {
  const { chat, source, timestamp, direction, summary, newSessionId } = opts;
  if (source.provider.compressSession) {
    return source.provider.compressSession(source.sessionIds, { cutoffTimestamp: timestamp, direction, summary, newSessionId });
  }
  if (source.provider.seedSession) {
    const turns = buildCompressedTurns(readChatSessionMessages(chat, source.sessionIds), { cutoffTimestamp: timestamp, direction, summary });
    return turns.length > 0 ? source.provider.seedSession(turns, { folder: chat.folder, newSessionId }) : null;
  }
  throw new UnsupportedForkError();
}

/**
 * Metadata a chat made out of another chat's history carries over from it:
 * permissions, reviewer screen, agent alias and branch. Not parentage, title,
 * provider, model or effort — those are the caller's decisions.
 */
export function inheritedChatFields(meta: Record<string, any>): Record<string, unknown> {
  return {
    // No card field is inherited: the fork is a child in the parentage tree
    // (parentChatId/rootChatId above), so its card membership — the root's
    // card — is derived from the tree by every reader.
    ...(meta.defaultPermissions && { defaultPermissions: meta.defaultPermissions }),
    // The reviewer screen carries over like the permissions it guards. Not
    // parentAnswers: a fork's parent is the original chat, which the user
    // never chose as an answerer.
    ...(meta.modelReview === true && { modelReview: true }),
    ...(meta.agentAlias && { agentAlias: meta.agentAlias }),
    ...(meta.lastBranch && { lastBranch: meta.lastBranch }),
  };
}
