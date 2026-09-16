import { Worker } from "node:worker_threads";
import type { Chat } from "shared";
import type { OwnedSession } from "./chat-discovery.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";

let running = 0;
/** Search the discovered corpus off-thread, under one response-wide deadline.
 * No provider's folder-hit cap is applied; aliases are reconciled without reads/writes.
 * Overload/time/byte-budget failures are explicit incomplete coverage.
 */
export async function collectContentMatches(query: string, sessions: OwnedSession[], stored: Chat[] = []) {
  if (running >= 2) return { keys: new Set<string>(), chatIds: new Set<string>(), warnings: ["Content search workers busy; retry this query"] };
  running++;
  try {
    const result = await new Promise<{ keys: string[]; warnings: string[] }>((resolve) => {
      const source = import.meta.url.endsWith(".ts");
      const moduleURL = new URL(source ? "./chat-content-worker.ts" : "./chat-content-worker.js", import.meta.url).href;
      // tsx is a devDependency and only a .ts run needs it, so its specifier travels
      // in workerData rather than inline: a literal `import("tsx/esm/api")` in this
      // worker source ships into backend/dist, where scripts/check-published-deps.mjs
      // reads it — rightly — as shipped code importing an undeclared package.
      const loader = source ? "tsx/esm/api" : null;
      const worker = new Worker(
        `
        (async () => {
          const { parentPort, workerData } = await import("node:worker_threads");
          try {
          if (workerData.loader) { const { register } = await import(workerData.loader); register(); }
          const { searchDiscoveredContent } = await import(workerData.moduleURL);
          parentPort.postMessage(await searchDiscoveredContent(workerData.query, workerData.sessions));
          } catch (error) { parentPort.postMessage({ keys: [], warnings: ["Content search worker failed: " + String(error)] }); }
        })();
      `,
        { eval: true, workerData: { loader, moduleURL, query, sessions }, resourceLimits: { maxOldGenerationSizeMb: 192 } },
      );
      const timer = setTimeout(() => {
        void worker.terminate();
        resolve({ keys: [], warnings: ["Content search exceeded the 15-second response budget"] });
      }, 15_000);
      worker.once("message", (result) => {
        clearTimeout(timer);
        void worker.terminate();
        resolve(result);
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        resolve({ keys: [], warnings: [`Content search worker failed: ${String(error)}`] });
      });
      worker.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) resolve({ keys: [], warnings: ["Content search worker terminated before completion"] });
      });
    });
    // Session identities include provider and ACP vendor. Logical chat IDs
    // must never enter this set: a chat ID can spell another session's ID.
    // Only the legacy REST response flattens these separate namespaces.
    const keys = new Set(result.keys);
    const chatIds = new Set<string>();
    const owners = new Map<string, Chat[]>();
    for (const chat of stored) {
      const meta = parseChatMetadata(chat.metadata);
      for (const sid of new Set([chat.session_id, ...(Array.isArray(meta.session_ids) ? meta.session_ids : [])])) {
        if (typeof sid !== "string") continue;
        const entries = owners.get(sid) ?? [];
        entries.push(chat);
        owners.set(sid, entries);
      }
    }
    for (const key of result.keys) {
      const [provider, vendor, sid] = JSON.parse(key) as [string, string | null, string];
      const compatible = (owners.get(sid) ?? []).filter((chat) => {
        const meta = parseChatMetadata(chat.metadata);
        return (!meta.provider || meta.provider === provider || chat.session_id !== sid) && (provider !== "acp" || meta.acpProviderId === vendor);
      });
      if (compatible.length === 1) chatIds.add(compatible[0].id);
    }
    return { keys, chatIds, warnings: result.warnings };
  } finally {
    running--;
  }
}
