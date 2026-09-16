import { getSessionProviders } from "../agents/factory.js";
import type { SessionProvider, DiscoveredSession } from "../agents/ports/SessionProvider.js";
import { isIgnoredProjectFolder } from "../utils/paths.js";

export type OwnedSession = DiscoveredSession & { providerKind: string };
/** No hit cap. An adapter that stops advancing is explicitly incomplete. */
export function discoverChatCorpus(providers: readonly SessionProvider[] = getSessionProviders()) {
  const sessions: OwnedSession[] = [];
  const warnings: string[] = [];
  for (const provider of providers) {
    const seen = new Set<string>();
    let offset = 0;
    try {
      for (;;) {
        // Built-in providers scan/sort before slicing. Request the complete
        // snapshot once, rather than rewalking it for every thousand rows.
        // Still drain adapters that impose their own page size, with stall checks.
        const page = provider.discoverSessions({ limit: Number.MAX_SAFE_INTEGER, offset });
        if (page.partial || provider.discoveryIncomplete) warnings.push(`${provider.kind}: discovery coverage incomplete`);
        if (page.warnings) warnings.push(...page.warnings.map((w) => `${provider.kind}: ${w}`));
        let added = 0;
        for (const s of page.sessions) {
          const key = JSON.stringify([s.sessionId, s.acpProviderId, s.filePath]);
          if (seen.has(key)) continue;
          seen.add(key);
          added++;
          if (!s.folder) {
            warnings.push(`${provider.kind}: working directory unavailable for ${s.sessionId}`);
            continue;
          }
          if (!isIgnoredProjectFolder(s.folder)) sessions.push({ ...s, providerKind: provider.kind });
        }
        offset += page.sessions.length;
        if (offset >= page.total) break;
        if (!added) {
          warnings.push(`${provider.kind}: discovery stopped before reported total`);
          break;
        }
      }
    } catch (error) {
      warnings.push(`${provider.kind}: discovery failed: ${String(error)}`);
    }
  }
  sessions.sort(
    (a, b) =>
      b.updatedAt.getTime() - a.updatedAt.getTime() ||
      a.sessionId.localeCompare(b.sessionId) ||
      a.providerKind.localeCompare(b.providerKind) ||
      (a.acpProviderId ?? "").localeCompare(b.acpProviderId ?? "") ||
      a.filePath.localeCompare(b.filePath),
  );
  return { sessions, warnings };
}
