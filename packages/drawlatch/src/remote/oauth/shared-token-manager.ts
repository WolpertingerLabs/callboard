/**
 * Process-wide shared {@link TokenManager} instance.
 *
 * Every token consumer — the proxy request path
 * ({@link ../tool-dispatch.executeProxyRequest}), test_connection, and the poll
 * ingestor ({@link ../ingestors/poll/poll-ingestor.PollIngestor}) — shares ONE
 * TokenManager, so a token minted for an identity on one path is reused on the
 * others (shared cache, single-flight latch, rotated-refresh-token state).
 * This module owns that instance. Ported from PR #26 (Card 3).
 *
 * Construction uses {@link TokenManager} defaults (`new TokenManager()` → global
 * `fetch` + `Date.now`). Tests substitute a manager with an injected fetch/clock
 * via {@link setSharedTokenManager} (and restore the default with
 * {@link resetSharedTokenManager}), so the construction site never has to be
 * monkey-patched in-place.
 */

import { TokenManager } from './token-manager.js';

let instance = new TokenManager();

/** Return the process-wide shared TokenManager. */
export function getSharedTokenManager(): TokenManager {
  return instance;
}

/**
 * Override the shared TokenManager (tests only). Lets a test inject a manager
 * built with a stubbed `fetch`/clock so both request paths exercise the same
 * deterministic token-endpoint behaviour.
 */
export function setSharedTokenManager(manager: TokenManager): void {
  instance = manager;
}

/** Restore a fresh default-constructed shared TokenManager (test teardown). */
export function resetSharedTokenManager(): void {
  instance = new TokenManager();
}
