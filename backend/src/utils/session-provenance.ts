import { statSync } from "node:fs";
import { parseChatMetadata } from "./chat-metadata.js";
import { getSessionProviders } from "../agents/factory.js";
import { SessionRoutingError } from "../agents/ports/SessionProvider.js";

/** Enrich response metadata without mutating storage or overriding explicit routing. */
export function withSessionProvider(metadata: string | null | undefined, provider: string): string {
  return JSON.stringify(withSessionProviderMeta(parseChatMetadata(metadata), provider));
}

/**
 * {@link withSessionProvider} on an already-parsed object, for hot paths that
 * would otherwise stringify only to have it parsed straight back. Returns a new
 * object; `meta` is not mutated.
 */
export function withSessionProviderMeta(meta: Record<string, any>, provider: string): Record<string, any> {
  // Explicit routing (including unknown/retired values) is authoritative.
  return { ...meta, provider: meta.provider ?? provider };
}

/** Resolve only within the explicit owner, rejecting conflicting resolver evidence. */
export function resolveSessionAcrossProviders(sessionId: string, metadata?: string | null) {
  const meta = parseChatMetadata(metadata);
  const matches = [];
  for (const provider of getSessionProviders()) {
    if (meta.provider != null && provider.kind !== meta.provider) continue;
    try {
      const resolved = provider.resolveSession(sessionId);
      if (resolved && statSync(resolved.logPath).isFile()) matches.push({ ...resolved, provider: provider.kind });
    } catch (err) {
      if (err instanceof SessionRoutingError) throw err;
      // Stale discovery entries must not hide stored records or other providers.
    }
  }
  if (matches.length > 1) throw new SessionRoutingError(`Conflicting providers for session "${sessionId}"`);
  return matches[0] ?? null;
}

/**
 * Current identity is separate from historical routing evidence. A historical
 * log may establish the provider but never the current thread's lifecycle.
 */
export function resolveSessionContext(sessionId: string, metadata?: string | null) {
  const current = resolveSessionAcrossProviders(sessionId, metadata);
  let provenance = current;
  if (!provenance) {
    const meta = parseChatMetadata(metadata);
    const ids = Array.isArray(meta.session_ids) ? meta.session_ids : [];
    const evidence = [...new Set<string>(ids.filter((id: unknown) => typeof id === "string" && id !== sessionId))]
      .map((id) => resolveSessionAcrossProviders(id, metadata))
      .filter((entry) => entry !== null);
    const owners = new Set(evidence.map((entry) => entry.provider));
    if (owners.size > 1) throw new SessionRoutingError("Conflicting provider provenance across recorded sessions");
    provenance = evidence[0] ?? null;
  }
  return {
    current,
    provenance,
    metadata: provenance ? withSessionProvider(metadata, provenance.provider) : (metadata ?? "{}"),
  };
}
