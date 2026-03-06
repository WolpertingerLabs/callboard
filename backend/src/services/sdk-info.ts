/**
 * SDK Info Service — Caches account info and supported models from the Agent SDK.
 *
 * Spawns a lightweight query at startup to extract initialization data
 * (account info, supported models) without actually running a conversation.
 * Results are cached for the lifetime of the process.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "os";
import { createLogger } from "../utils/logger.js";

const log = createLogger("sdk-info");

export interface CachedAccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
}

export interface CachedModelInfo {
  value: string;
  displayName: string;
  description: string;
}

interface SdkInfoCache {
  account: CachedAccountInfo | null;
  models: CachedModelInfo[];
  fetchedAt: number;
}

let cache: SdkInfoCache | null = null;
let fetchPromise: Promise<SdkInfoCache> | null = null;

/**
 * Fetch account info and supported models from the Agent SDK.
 * Uses a minimal query that is closed immediately after extracting init data.
 */
async function fetchSdkInfo(): Promise<SdkInfoCache> {
  log.info("Fetching SDK info (account + models)...");

  try {
    // Use streaming input mode so the query waits for input instead of auto-completing
    const inputStream = (async function* () {
      // Yield nothing — we just need the query to initialize
      // and then we'll close it after reading init data
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: "hi" },
        parent_tool_use_id: null,
        session_id: "",
      };
    })();

    const conversation = query({
      prompt: inputStream,
      options: {
        cwd: tmpdir(),
        tools: [],
        maxTurns: 1,
        persistSession: false,
        settingSources: ["user"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env: {
          ...process.env,
          CLAUDECODE: undefined,
        },
      },
    });

    // Read init data from the query object
    const [account, models] = await Promise.all([conversation.accountInfo(), conversation.supportedModels()]);

    // Close the query — we don't need to actually run a conversation
    conversation.close();

    const result: SdkInfoCache = {
      account: account || null,
      models: (models || []).map((m: any) => ({
        value: m.value,
        displayName: m.displayName,
        description: m.description,
      })),
      fetchedAt: Date.now(),
    };

    log.info(`SDK info fetched: ${result.models.length} models, account=${result.account?.email || "unknown"}`);
    return result;
  } catch (err: any) {
    log.error(`Failed to fetch SDK info: ${err.message}`);
    return { account: null, models: [], fetchedAt: Date.now() };
  }
}

/**
 * Initialize the SDK info cache. Call once at startup.
 * Non-blocking — runs in the background.
 */
export function initSdkInfoCache(): void {
  if (fetchPromise) return;
  fetchPromise = fetchSdkInfo().then((result) => {
    cache = result;
    return result;
  });
}

/**
 * Get cached SDK info. Returns null if not yet fetched.
 */
export function getSdkInfo(): SdkInfoCache | null {
  return cache;
}

/**
 * Get cached SDK info, waiting for the initial fetch if needed.
 */
export async function getSdkInfoAsync(): Promise<SdkInfoCache> {
  if (cache) return cache;
  if (fetchPromise) return fetchPromise;
  // If init was never called, do it now
  initSdkInfoCache();
  return fetchPromise!;
}
