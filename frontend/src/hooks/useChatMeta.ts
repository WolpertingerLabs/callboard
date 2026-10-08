import { useMemo } from "react";
import type { NativeCodexAgent } from "shared/types/chat.js";
import type { DefaultPermissions, EffortLevel, UiAgentProviderKind } from "shared/types/index.js";

/**
 * The fields the Chat page reads off a chat's `metadata` JSON string, each
 * already narrowed to the shape its readers accept. A field that is missing or
 * of the wrong type is absent here, exactly as if the metadata didn't carry it;
 * metadata that doesn't parse (or isn't an object) reads as carrying nothing.
 */
export interface ChatMeta {
  /** The raw `metadata.provider` — non-empty string or null. Not normalized: see {@link providerKindOf}. */
  provider: string | null;
  jobRunId?: string;
  /** Not validated beyond being present: the native-child view trusts the daemon's shape. */
  nativeAgent?: NativeCodexAgent;
  /** Explicit Callboard parentage, when a non-empty string. */
  parentChatId?: string;
  acpProviderId?: string;
  model?: string;
  effort?: EffortLevel;
  /** Present when truthy; still to be run through `normalizePermissions`. */
  defaultPermissions?: DefaultPermissions;
  /** The agent the chat was started from — agent chats run with the agent tool set. */
  agentAlias?: string;
  /** The chat's own space stamp (absent = General). Moving the tree rewrites it. */
  spaceId?: string;
}

const NO_META: ChatMeta = { provider: null };

/** Parse a chat's metadata string once. Never throws. */
export function parseChatMeta(metadata: string | null | undefined): ChatMeta {
  if (!metadata) return NO_META;
  let raw: unknown;
  try {
    raw = JSON.parse(metadata);
  } catch {
    return NO_META;
  }
  if (!raw || typeof raw !== "object") return NO_META;
  const meta = raw as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" ? value : undefined);
  const nonEmpty = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return {
    provider: nonEmpty(meta.provider) ?? null,
    jobRunId: str(meta.jobRunId),
    nativeAgent: (meta.nativeAgent || undefined) as NativeCodexAgent | undefined,
    parentChatId: nonEmpty(meta.parentChatId),
    acpProviderId: str(meta.acpProviderId),
    model: str(meta.model),
    effort: str(meta.effort) as EffortLevel | undefined,
    defaultPermissions: (meta.defaultPermissions || undefined) as DefaultPermissions | undefined,
    agentAlias: nonEmpty(meta.agentAlias),
    spaceId: nonEmpty(meta.spaceId),
  };
}

/**
 * The harness kind a chat runs on, from its raw `metadata.provider`. Anything
 * unrecognized — absent, a retired harness — collapses to "claude-code".
 */
export function providerKindOf(provider: string | null): UiAgentProviderKind {
  if (provider === "codex" || provider === "acp" || provider === "cline" || provider === "pi") return provider;
  return "claude-code";
}

/** {@link parseChatMeta}, memoized on the metadata string. */
export function useChatMeta(metadata: string | null | undefined): ChatMeta {
  return useMemo(() => parseChatMeta(metadata), [metadata]);
}
