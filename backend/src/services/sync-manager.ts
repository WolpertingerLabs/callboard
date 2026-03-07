/**
 * Sync manager — holds pending key exchange state and delegates to drawlatch.
 *
 * Only one sync session at a time (matches drawlatch's single-session model).
 */
import { startKeyExchange, type KeyExchangeInit, SyncClientError } from "@wolpertingerlabs/drawlatch/shared/protocol";
import { getActiveMcpConfigDir } from "./agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("sync-manager");

let pendingExchange: KeyExchangeInit | null = null;

export interface InitSyncOpts {
  remoteUrl: string;
  inviteCode: string;
  encryptionKey: string;
  callerAlias: string;
}

export async function initSync(opts: InitSyncOpts): Promise<{ confirmCode: string }> {
  // Cancel any existing exchange
  pendingExchange = null;

  const configDir = getActiveMcpConfigDir();
  if (!configDir) throw new Error("No MCP config directory configured");

  log.info(`Starting sync with ${opts.remoteUrl} as caller "${opts.callerAlias}"`);

  const exchange = await startKeyExchange({
    remoteUrl: opts.remoteUrl,
    inviteCode: opts.inviteCode,
    encryptionKey: opts.encryptionKey,
    callerAlias: opts.callerAlias,
    configDir,
  });

  pendingExchange = exchange;
  return { confirmCode: exchange.confirmCode };
}

export async function completeSync(): Promise<{ callerAlias: string; fingerprint: string }> {
  if (!pendingExchange) {
    throw new Error("No pending sync session");
  }

  try {
    const result = await pendingExchange.complete();
    log.info(`Sync complete — caller="${result.callerAlias}" fingerprint=${result.fingerprint}`);
    return { callerAlias: result.callerAlias, fingerprint: result.fingerprint };
  } finally {
    pendingExchange = null;
  }
}

export function cancelSync(): void {
  if (pendingExchange) {
    log.info("Sync cancelled");
  }
  pendingExchange = null;
}

export function hasPendingSync(): boolean {
  return pendingExchange !== null;
}

export { SyncClientError };
