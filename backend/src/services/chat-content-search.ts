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
  if (running >= 2) return { keys: new Set<string>(), warnings: ["Content search workers busy; retry this query"] };
  running++;
  try {
    const result = await new Promise<{ keys: string[]; warnings: string[] }>((resolve) => {
      const source = import.meta.url.endsWith(".ts");
      const moduleURL = new URL(source ? "./chat-content-worker.ts" : "./chat-content-worker.js", import.meta.url).href;
      const worker = new Worker(
        `
        (async () => {
          const { parentPort, workerData } = await import("node:worker_threads");
          try {
          if (workerData.source) { const { register } = await import("tsx/esm/api"); register(); }
          const { searchDiscoveredContent } = await import(workerData.moduleURL);
          parentPort.postMessage(await searchDiscoveredContent(workerData.query, workerData.sessions));
          } catch (error) { parentPort.postMessage({ keys: [], warnings: ["Content search worker failed: " + String(error)] }); }
        })();
      `,
        { eval: true, workerData: { source, moduleURL, query, sessions }, resourceLimits: { maxOldGenerationSizeMb: 192 } },
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
    const keys = new Set(result.keys);
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
      const [provider, sid] = JSON.parse(key) as [string, string];
      const compatible = (owners.get(sid) ?? []).filter((chat) => {
        const meta = parseChatMetadata(chat.metadata);
        return !meta.provider || meta.provider === provider || chat.session_id !== sid;
      });
      if (compatible.length === 1) keys.add(JSON.stringify([provider, compatible[0].id]));
    }
    return { keys, warnings: result.warnings };
  } finally {
    running--;
  }
}
