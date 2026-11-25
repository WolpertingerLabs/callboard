/**
 * On-disk layout migrations — drawlatch owns the evolution of its own config dir.
 *
 * The config-dir contract (stable, documented):
 *
 *   $MCP_CONFIG_DIR/                 (default: ~/.drawlatch)
 *     remote.config.json             — RemoteServerConfig (callers, connectors, port…)
 *     proxy.config.json              — ProxyConfig (local MCP proxy → remote URL)
 *     .env                           — secret values (prefixed per caller)
 *     keys/
 *       server/                      — the daemon's own Ed25519 + X25519 keypair
 *       callers/<alias>/             — one keypair per caller alias
 *
 * Historically the key directories used a different layout
 * (`keys/local`, `keys/remote`, `keys/peers/*`). These migrations move any
 * legacy layout to the current one. They were previously implemented in
 * callboard (`migrateKeyDirectories`); drawlatch now owns them so it controls
 * its own layout evolution and callboard can delete the duplicate.
 *
 * All functions are idempotent and safe to call on every startup.
 */

import { existsSync, mkdirSync, renameSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

import { getKeysDir } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('migrations');

/** Copy *.pub.pem files from src to dest, creating dest if needed. */
function copyPublicKeys(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const files = readdirSync(src).filter((f) => f.endsWith('.pub.pem'));
  for (const file of files) {
    const destFile = join(dest, file);
    if (!existsSync(destFile)) {
      copyFileSync(join(src, file), destFile);
    }
  }
}

/**
 * Migrate the legacy key directory layout to the current callers/server layout.
 *
 *   keys/local/<alias>/        → keys/callers/<alias>/
 *   keys/remote/               → keys/server/
 *   keys/peers/remote-server/  → keys/server/  (public keys only)
 *   keys/peers/<alias>/        → keys/callers/<alias>/  (public keys only)
 *
 * Idempotent: only renames when the old dir exists and the new one does not.
 *
 * @param keysDir  The keys directory to migrate. Defaults to `getKeysDir()`.
 */
export function migrateKeyLayout(keysDir: string = getKeysDir()): void {
  if (!existsSync(keysDir)) return;

  const oldLocal = join(keysDir, 'local');
  const oldRemote = join(keysDir, 'remote');
  const oldPeers = join(keysDir, 'peers');
  const newCallers = join(keysDir, 'callers');
  const newServer = join(keysDir, 'server');

  try {
    // keys/local/ → keys/callers/
    if (existsSync(oldLocal) && !existsSync(newCallers)) {
      renameSync(oldLocal, newCallers);
      log.info(`Migrated ${oldLocal} -> ${newCallers}`);
    }

    // keys/remote/ → keys/server/
    if (existsSync(oldRemote) && !existsSync(newServer)) {
      renameSync(oldRemote, newServer);
      log.info(`Migrated ${oldRemote} -> ${newServer}`);
    }

    // keys/peers/ — merge individual peer dirs into callers/server
    if (existsSync(oldPeers)) {
      const entries = readdirSync(oldPeers, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        if (entry.name === 'remote-server') {
          // peers/remote-server/ → server/ (copy .pub.pem files)
          copyPublicKeys(join(oldPeers, entry.name), newServer);
          log.info(`Migrated ${join(oldPeers, entry.name)} -> ${newServer}`);
        } else {
          // peers/<alias>/ → callers/<alias>/ (copy .pub.pem files)
          const targetDir = join(newCallers, entry.name);
          copyPublicKeys(join(oldPeers, entry.name), targetDir);
          log.info(`Migrated ${join(oldPeers, entry.name)} -> ${targetDir}`);
        }
      }

      // Remove the now-merged peers directory
      try {
        rmSync(oldPeers, { recursive: true });
        log.info(`Removed old ${oldPeers} directory`);
      } catch {
        // Not critical — may still have unexpected files
      }
    }

    // Clean up empty old directories
    for (const dir of [oldLocal, oldRemote]) {
      if (existsSync(dir)) {
        try {
          if (readdirSync(dir).length === 0) rmSync(dir);
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    log.warn(`Failed to migrate key directories in ${keysDir}: ${String(err)}`);
  }
}

/**
 * Run every config-dir layout migration for the active `MCP_CONFIG_DIR`.
 * Call once at daemon startup before keys/config are loaded.
 */
export function migrateConfigDir(): void {
  migrateKeyLayout();
}
