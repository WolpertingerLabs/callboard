/**
 * What package this process **is**, as opposed to what is on disk right now.
 *
 * Callboard upgrades itself with `npm install -g @wolpertingerlabs/callboard`,
 * and npm replaces the package tree *in place*. From the moment npm exits, every
 * read of `<pkgRoot>/package.json` describes the code **on disk** — which is no
 * longer the code this process is executing, and will not be until the daemon
 * restarts. Before this module existed there was no value anywhere in the system
 * that meant "the version this process is running", and three separate bugs fell
 * out of that single absence:
 *
 * - the self-update's `changed` test compared a freshly-read `fromVersion`
 *   against a freshly-read `installedVersion`, so a *second* press read the same
 *   already-overwritten file on both sides, concluded nothing had changed, and
 *   reported "there is nothing to restart into" while the daemon went on
 *   executing the old code. The documented retry — "press this again once things
 *   are idle" — could therefore never restart anything;
 * - `/api/system-info` reported the on-disk version as the running one, so the
 *   About page's "Update available" test went false the instant npm exited and
 *   took the whole update banner — verdicts, retry button, reattach path — off
 *   the screen, in exactly the window it was written for;
 * - a second daemon sharing one global install had no way to notice that its own
 *   files had been replaced underneath it.
 *
 * So the manifest is read **once, at module load**, and that snapshot is the
 * answer to "what is running". It is deliberately not refreshable: a function
 * that could re-read it would be a function someone could call after npm, which
 * is the entire defect.
 *
 * The per-call reader {@link readPackageManifest} is still exported, because the
 * *other* question — "what did npm just write?" — is a real one with a real
 * caller. The two are different questions and now have different names.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * npm's own package-name grammar, near enough — and one deliberate narrowing.
 *
 * A name reaching an argv must not be able to look like a flag, so the leading
 * character class excludes `-`. npm itself permits `-` there; `npm install -g
 * --force` does not mean what a package called `--force` would want it to, and
 * "the name is checked rather than trusted" has to include that. Every other
 * position keeps npm's grammar so a fork that renames the package still works.
 */
export const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/;

/** The three fields anything in this codebase has business reading out of a `package.json`. */
export interface PackageManifest {
  name: string;
  version: string;
  /** The CLI entry, relative to the package root, as the `bin` field declares it. */
  bin?: string;
}

/**
 * Read a `package.json` **now**.
 *
 * For the question "what is in that directory at this instant" — which is a fair
 * question to ask of the *newly installed* package after npm exits, and never
 * the right one to ask about the running process. Returns `null` rather than
 * throwing, and rejects a manifest whose `name` is not a package name at all
 * rather than passing it on towards a spawn.
 */
export function readPackageManifest(root: string): PackageManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
    const name = typeof parsed?.name === "string" ? parsed.name : "";
    const version = typeof parsed?.version === "string" ? parsed.version : "";
    if (!PACKAGE_NAME_PATTERN.test(name) || !version) return null;
    // `bin` is either a string or a map; both forms are npm's, and Callboard's
    // own is the map. Any entry will do — the package publishes one.
    const bin = parsed?.bin;
    const rel = typeof bin === "string" ? bin : bin && typeof bin === "object" ? Object.values(bin).find((v): v is string => typeof v === "string") : undefined;
    return { name, version, ...(rel ? { bin: rel } : {}) };
  } catch {
    return null;
  }
}

/**
 * This daemon's package root — `backend/dist/utils/package-manifest.js` up three.
 *
 * Derived here rather than passed in, unlike `buildSystemInfo`'s, for two
 * reasons that pull the same way: the boot snapshot below has to be taken at
 * *module load*, before any caller exists to hand it a path, and the
 * self-update's install-source gate turns on this directory being the module's
 * own location rather than a value someone supplied.
 *
 * `index.ts` derives the same path from its own depth (`../..` from
 * `backend/dist/index.js`). Two derivations, both correct, and neither can be
 * collapsed into the other: this file is imported *by* index.ts, so its module
 * body runs first.
 */
export const BOOT_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The manifest as it was when this process started, or `null` if it could not be
 * read then.
 *
 * Frozen, and captured at import time on purpose — see this module's header.
 */
export const BOOT_MANIFEST: Readonly<PackageManifest> | null = Object.freeze(readPackageManifest(BOOT_PACKAGE_ROOT));

/** The version of the code this process is executing. `null` when the manifest was unreadable at boot. */
export const BOOT_VERSION: string | null = BOOT_MANIFEST?.version ?? null;
