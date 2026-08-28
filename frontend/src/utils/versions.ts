/**
 * "Is the version npm publishes newer than the one this daemon is running?"
 *
 * Lifted out of `pages/settings/AboutSettings.tsx` when the self-update banner
 * needed the same answer. It is deliberately one implementation rather than two:
 * this comparison is what decides whether Callboard offers to install something,
 * and a banner that disagreed with the row above it about which version is newer
 * would be a button pointing at nothing.
 *
 * Semver-shaped rather than semver-complete — it handles the pre-release tags
 * this project actually ships (`1.0.0-alpha.52`), including the two rules that a
 * naive string compare gets wrong: a release outranks its own pre-releases, and
 * `alpha.10` outranks `alpha.9`. Build metadata (`+sha`) is not parsed, because
 * nothing in this project publishes it.
 *
 * The backend has its own copy in `services/npm-registry.ts` for the engine
 * cards. They are not shared: `shared/` is types, and a runtime helper crossing
 * that boundary would be the first one.
 */

/**
 * Compare two semver strings. Returns > 0 if a > b, < 0 if a < b, 0 if equal.
 * Handles pre-release segments: 1.0.0 > 1.0.0-alpha.1, alpha.10 > alpha.9.
 */
export function compareVersions(a: string, b: string): number {
  const parseVer = (v: string) => {
    const [core, pre] = v.split("-", 2);
    const parts = core.split(".").map(Number);
    return { parts, pre: pre || null };
  };
  const va = parseVer(a);
  const vb = parseVer(b);

  const maxLen = Math.max(va.parts.length, vb.parts.length);
  for (let i = 0; i < maxLen; i++) {
    const pa = va.parts[i] || 0;
    const pb = vb.parts[i] || 0;
    if (pa !== pb) return pa - pb;
  }

  // Same core: no pre-release > pre-release
  if (!va.pre && vb.pre) return 1;
  if (va.pre && !vb.pre) return -1;
  if (!va.pre && !vb.pre) return 0;

  // Both have pre-release: compare segments
  const aParts = va.pre!.split(".");
  const bParts = vb.pre!.split(".");
  const preLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < preLen; i++) {
    const sa = aParts[i];
    const sb = bParts[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    const na = Number(sa);
    const nb = Number(sb);
    const aIsNum = !isNaN(na);
    const bIsNum = !isNaN(nb);
    if (aIsNum && bIsNum) {
      if (na !== nb) return na - nb;
    } else if (aIsNum) {
      return -1; // numbers sort before strings
    } else if (bIsNum) {
      return 1;
    } else {
      if (sa < sb) return -1;
      if (sa > sb) return 1;
    }
  }
  return 0;
}

/** Returns true if remote version is newer than local. */
export function isNewerVersion(local: string, remote: string): boolean {
  if (!local || !remote || local === remote) return false;
  return compareVersions(remote, local) > 0;
}
