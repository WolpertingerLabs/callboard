/**
 * "What does npm publish as latest for this package?", generalized.
 *
 * ## Why this exists
 *
 * The same fetch-and-cache existed twice before this file, both times hardcoded
 * to callboard's own package name:
 *
 * - `bin/callboard.js` (`fetchLatestVersion` + `readVersionCache` /
 *   `writeVersionCache`, cached at `<DATA_DIR>/version-check.json`), and
 * - the `/api/system-info` handler in `backend/src/index.ts`, which reads and
 *   writes that *same* file so either process warms the cache for the other.
 *
 * Engine status needs the same answer for five *other* packages, so the shape is
 * lifted here and keyed by package name. The two existing call sites are
 * deliberately left alone — see the note at the bottom of this comment.
 *
 * ## Contract
 *
 * Best-effort, always. An offline daemon, a 500 from the registry, a corrupt
 * cache file, a read-only data dir: every one of them resolves to `undefined`
 * for that package. Nothing here throws, because the only caller is a status
 * endpoint whose whole job is to degrade honestly — an absent "Latest" row is a
 * fine answer, a 500 on Settings → API is not.
 *
 * ## Cache
 *
 * `<DATA_DIR>/engine-versions.json`, one entry per package, 4-hour TTL (the same
 * TTL the two implementations above use). On disk rather than in memory so a
 * daemon restart does not re-hit the registry, and one file rather than one per
 * package so a fan-out over five engines is a single read and a single write.
 *
 * Deliberately a *different* file from `version-check.json`: that one is shared
 * between the CLI and the daemon and holds a bare `{ latestVersion, ts }` for
 * callboard itself. Re-pointing either of those at this file would silently
 * un-share that cache, and `bin/callboard.js` additionally has to run in a
 * checkout where `backend/dist` has never been built — so it cannot import this
 * module at all.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("npm-registry");

/** How long a cached answer stays fresh. Matches `bin/callboard.js`'s version check. */
const TTL_MS = 4 * 60 * 60 * 1000;

/** Cap on a single registry request, so a hung network cannot hold a route open. */
const FETCH_TIMEOUT_MS = 5_000;

/** One package's cached answer. */
interface CacheEntry {
  latestVersion: string;
  /** Epoch ms of the fetch that produced it. */
  ts: number;
}

type CacheFile = Record<string, CacheEntry>;

function cachePath(): string {
  return join(DATA_DIR, "engine-versions.json");
}

/** Read the whole cache file. A missing or corrupt file is an empty cache, not an error. */
function readCache(): CacheFile {
  try {
    const file = cachePath();
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as CacheFile;
  } catch {
    return {};
  }
}

/** Write the whole cache file. Best effort — a lost write costs one registry call. */
function writeCache(cache: CacheFile): void {
  try {
    const file = cachePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cache, null, 2) + "\n");
  } catch (err) {
    log.debug(`could not persist npm version cache: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Ask the registry for one package's `latest` dist-tag. Never throws. */
async function fetchLatest(pkg: string): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { version?: string };
      return typeof data.version === "string" && data.version ? data.version : undefined;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Offline, DNS failure, abort, malformed JSON — all the same answer.
    return undefined;
  }
}

/**
 * Latest published version for each package, from cache when fresh.
 *
 * Batched rather than looped so a fan-out over every engine is one cache read,
 * N parallel requests, and one cache write — a per-package write would let the
 * last writer clobber its siblings' entries.
 *
 * @param packages package names; duplicates are collapsed
 * @param opts.refresh ignore cached entries and re-fetch (the `?refresh=1` path)
 * @returns one key per requested package; `undefined` where nothing could be learned
 */
export async function getLatestVersions(packages: string[], opts: { refresh?: boolean } = {}): Promise<Record<string, string | undefined>> {
  const wanted = [...new Set(packages.filter((p) => typeof p === "string" && p.trim().length > 0))];
  const result: Record<string, string | undefined> = {};
  if (wanted.length === 0) return result;

  const cache = readCache();
  const now = Date.now();
  const stale: string[] = [];

  for (const pkg of wanted) {
    const entry = cache[pkg];
    const fresh = entry && typeof entry.ts === "number" && now - entry.ts < TTL_MS && typeof entry.latestVersion === "string";
    if (fresh && !opts.refresh) {
      result[pkg] = entry.latestVersion;
    } else {
      stale.push(pkg);
      // Seed with the stale value so a failed refetch degrades to "what we last
      // knew" rather than to nothing. Overwritten below when the fetch lands.
      result[pkg] = typeof entry?.latestVersion === "string" ? entry.latestVersion : undefined;
    }
  }

  if (stale.length === 0) return result;

  const fetched = await Promise.all(stale.map(async (pkg) => [pkg, await fetchLatest(pkg)] as const));

  let dirty = false;
  for (const [pkg, version] of fetched) {
    if (!version) continue;
    result[pkg] = version;
    cache[pkg] = { latestVersion: version, ts: now };
    dirty = true;
  }
  if (dirty) writeCache(cache);

  return result;
}

/** {@link getLatestVersions} for a single package. */
export async function getLatestVersion(pkg: string, opts: { refresh?: boolean } = {}): Promise<string | undefined> {
  const versions = await getLatestVersions([pkg], opts);
  return versions[pkg];
}

/**
 * Is `remote` newer than `local`?
 *
 * A port of `bin/callboard.js`'s `isNewerVersion`, kept identical in behaviour:
 * numeric dotted segments compared left to right, then a release beats any
 * prerelease of the same base, then prereleases compare lexically. Unparseable
 * or equal input is "no".
 */
export function isNewerVersion(local: string | undefined, remote: string | undefined): boolean {
  if (!local || !remote || local === remote) return false;

  const [localBase, localPre] = local.split("-");
  const [remoteBase, remotePre] = remote.split("-");
  const localParts = localBase.split(".").map(Number);
  const remoteParts = remoteBase.split(".").map(Number);

  for (let i = 0; i < Math.max(localParts.length, remoteParts.length); i++) {
    const l = localParts[i] || 0;
    const r = remoteParts[i] || 0;
    if (r > l) return true;
    if (r < l) return false;
  }

  // Same base version — a release outranks any prerelease of it.
  if (!remotePre && localPre) return true;
  if (remotePre && !localPre) return false;
  if (remotePre && localPre) return remotePre > localPre;
  return false;
}

/** Test seam: drop the on-disk cache so the next call re-fetches. */
export function resetNpmVersionCache(): void {
  writeCache({});
}
