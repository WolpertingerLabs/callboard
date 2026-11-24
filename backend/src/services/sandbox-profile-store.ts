/**
 * Agent-built Sandbox desktop profiles, on disk: every version an agent
 * proposed, which one a human approved, and where the profile came from.
 *
 *     <data dir>/sandbox-desktop/profiles/            0700
 *       <scope>/                                       0700  (`w<12 hex>`, or `global` once promoted)
 *         <name>.json                                  0600  one profile: its versions and provenance
 *
 * Like sandbox-profiles.ts this imports only node builtins, the
 * computer-use package and utils/paths.ts: `callboard sandbox build
 * --profile` and `profiles` list these too.
 *
 * **What this file guarantees.** Every path it touches is built from a scope
 * key (`global` or `w` + 12 hex digits) and a profile name (the recipe
 * grammar: `[a-z0-9-]`, no dots or slashes), both checked before any `join`,
 * so nothing a recipe says can name a path outside the store. Writes are
 * atomic (a fresh `wx` temp file, then `rename`, which replaces a symlink
 * rather than following it), files are 0600 and directories 0700 (chmod'ed
 * after `mkdir`, whatever the umask), and a store directory that is a
 * symlink is refused. Reading re-validates every version: its recipe must
 * parse, be in canonical form, and hash to its stored digest; one that does
 * not is dropped as if it were not there, so a hand-edited file cannot slip
 * a recipe past the digest a human approved.
 *
 * **What it does not decide.** Who may write (the proposal manager, a human
 * through Settings), and when a build happens (never here: approving a
 * version only marks it; the queue builds, sandbox-builds.ts).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalProfileRecipe,
  isProfileName,
  isProfileScopeKey,
  parseProfileRecipe,
  profileRecipeDigest,
  type ProfileRecipe,
  type ProfileScopeKey,
} from "@wolpertingerlabs/computer-use";
import { DATA_DIR } from "../utils/paths.js";

export type StoredVersionState = "proposed" | "approved" | "superseded" | "refused" | "withdrawn";

export interface StoredVersion {
  version: number;
  /** `profileRecipeDigest` of `recipe`. */
  digest: string;
  /** The canonical recipe text (`canonicalProfileRecipe`). */
  recipe: string;
  /** The proposal's request id: what the agent's notices name it by. */
  requestId?: string;
  /** The agent's note: untrusted, already escaped and capped by the proposal manager. */
  note?: string;
  proposedAt: number;
  /** The chat whose agent proposed it. */
  proposedBy: string;
  state: StoredVersionState;
  approvedAt?: number;
  /** The proposal request id the human approved it under. */
  approvalId?: string;
  /** The build its approval queued. */
  buildId?: string;
}

export interface StoredProfile {
  schema: 1;
  scope: ProfileScopeKey;
  name: string;
  createdAt: number;
  /** The chat whose proposal created it. */
  createdBy: string;
  /** Where it lives, for a human ("workspace …", "folder /path"); captured when it was first proposed. */
  ownerLabel?: string;
  /** The approved version in force. */
  current?: number;
  /** The next version number: never reused, even after older versions are dropped. */
  nextVersion: number;
  versions: StoredVersion[];
  /** Set when a human promoted it to the global scope. */
  promoted?: { at: number; fromScope: ProfileScopeKey; fromVersion: number };
}

/** A cap that refused a write: `profiles` (per scope) or `versions` (nothing left to drop). */
export class ProfileStoreLimitError extends Error {
  readonly code = "limit";
  constructor(
    readonly limit: "profiles" | "versions",
    message: string,
  ) {
    super(message);
  }
}

const DIGEST = /^[0-9a-f]{64}$/;
const STATES: readonly StoredVersionState[] = ["proposed", "approved", "superseded", "refused", "withdrawn"];
const NOTE_MAX = 1000;

export const profileStoreRoot = (dataDir = DATA_DIR) => join(dataDir, "sandbox-desktop", "profiles");

function checkKey(scope: unknown, name: unknown): asserts scope is ProfileScopeKey {
  if (!isProfileScopeKey(scope)) throw Object.assign(new Error("Invalid profile scope"), { code: "invalid_request" });
  if (!isProfileName(name)) throw Object.assign(new Error("Invalid profile name"), { code: "invalid_request" });
}

/** A directory of ours: created 0700, never a symlink. */
function ensureDir(dir: string): void {
  if (existsSync(dir)) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing to use ${dir}: it is not a plain directory`);
  } else mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** One stored version, re-validated; undefined when anything about it is off. */
function readVersion(raw: unknown, name: string): StoredVersion | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  if (!Number.isInteger(v.version) || (v.version as number) < 1) return undefined;
  if (typeof v.digest !== "string" || !DIGEST.test(v.digest) || typeof v.recipe !== "string") return undefined;
  if (typeof v.proposedAt !== "number" || typeof v.proposedBy !== "string" || !STATES.includes(v.state as StoredVersionState)) return undefined;
  let recipe: ProfileRecipe;
  try {
    recipe = parseProfileRecipe(v.recipe);
  } catch {
    return undefined;
  }
  // Canonical, the recipe this profile is named for, and exactly the digest recorded: what a human was shown is what is built.
  if (recipe.name !== name || canonicalProfileRecipe(recipe) !== v.recipe || profileRecipeDigest(recipe) !== v.digest) return undefined;
  return {
    version: v.version as number,
    digest: v.digest,
    recipe: v.recipe,
    ...(typeof v.requestId === "string" && /^[0-9a-f-]{36}$/.test(v.requestId) ? { requestId: v.requestId } : {}),
    ...(typeof v.note === "string" ? { note: v.note.slice(0, NOTE_MAX) } : {}),
    proposedAt: v.proposedAt,
    proposedBy: v.proposedBy,
    state: v.state as StoredVersionState,
    ...(typeof v.approvedAt === "number" ? { approvedAt: v.approvedAt } : {}),
    ...(typeof v.approvalId === "string" ? { approvalId: v.approvalId } : {}),
    ...(typeof v.buildId === "string" ? { buildId: v.buildId } : {}),
  };
}

function readProfile(text: string, scope: ProfileScopeKey, name: string): StoredProfile | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || raw.schema !== 1 || raw.scope !== scope || raw.name !== name) return undefined;
  if (typeof raw.createdAt !== "number" || typeof raw.createdBy !== "string" || !Number.isInteger(raw.nextVersion)) return undefined;
  const versions = (Array.isArray(raw.versions) ? raw.versions : [])
    .map((v) => readVersion(v, name))
    .filter((v): v is StoredVersion => !!v)
    .sort((a, b) => a.version - b.version);
  const current =
    Number.isInteger(raw.current) && versions.some((v) => v.version === raw.current && v.state === "approved") ? (raw.current as number) : undefined;
  const promoted = raw.promoted as { at?: unknown; fromScope?: unknown; fromVersion?: unknown } | undefined;
  return {
    schema: 1,
    scope,
    name,
    createdAt: raw.createdAt,
    createdBy: raw.createdBy,
    ...(typeof raw.ownerLabel === "string" ? { ownerLabel: raw.ownerLabel.slice(0, 500) } : {}),
    ...(current !== undefined ? { current } : {}),
    nextVersion: Math.max(raw.nextVersion as number, ...versions.map((v) => v.version + 1), 1),
    versions,
    ...(promoted && typeof promoted.at === "number" && isProfileScopeKey(promoted.fromScope) && Number.isInteger(promoted.fromVersion)
      ? { promoted: { at: promoted.at, fromScope: promoted.fromScope, fromVersion: promoted.fromVersion as number } }
      : {}),
  };
}

/** The recipe a stored profile has in force: its approved version's, parsed. Undefined with none approved. */
export function currentRecipe(profile: StoredProfile): { recipe: ProfileRecipe; version: StoredVersion } | undefined {
  const version = profile.versions.find((v) => v.version === profile.current);
  return version ? { recipe: parseProfileRecipe(version.recipe), version } : undefined;
}

export class ProfileStore {
  private readonly memo = new Map<string, { stamp: string; profile: StoredProfile | undefined }>();
  constructor(readonly root = profileStoreRoot()) {}

  private file(scope: ProfileScopeKey, name: string): string {
    checkKey(scope, name);
    return join(this.root, scope, `${name}.json`);
  }

  /** The scopes with at least one stored profile. */
  scopes(): ProfileScopeKey[] {
    try {
      return readdirSync(this.root).filter((dir): dir is ProfileScopeKey => isProfileScopeKey(dir));
    } catch {
      return [];
    }
  }

  read(scope: ProfileScopeKey, name: string): StoredProfile | undefined {
    const file = this.file(scope, name);
    let stamp: string;
    try {
      const stat = statSync(file);
      if (!stat.isFile()) return undefined;
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      this.memo.delete(file);
      return undefined;
    }
    const memo = this.memo.get(file);
    if (memo?.stamp === stamp) return memo.profile && structuredClone(memo.profile);
    let profile: StoredProfile | undefined;
    try {
      profile = readProfile(readFileSync(file, "utf8"), scope, name);
    } catch {
      profile = undefined;
    }
    this.memo.set(file, { stamp, profile });
    return profile && structuredClone(profile);
  }

  /** Every stored profile in one scope (or in every scope). */
  list(scope?: ProfileScopeKey): StoredProfile[] {
    const scopes = scope ? [scope] : this.scopes();
    const out: StoredProfile[] = [];
    for (const s of scopes) {
      let files: string[];
      try {
        files = readdirSync(join(this.root, s)).filter((file) => file.endsWith(".json"));
      } catch {
        continue;
      }
      for (const file of files.sort()) {
        const name = file.slice(0, -".json".length);
        if (!isProfileName(name)) continue;
        const profile = this.read(s, name);
        if (profile) out.push(profile);
      }
    }
    return out;
  }

  private write(profile: StoredProfile): void {
    const file = this.file(profile.scope, profile.name);
    ensureDir(this.root);
    ensureDir(join(this.root, profile.scope));
    const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
    this.memo.delete(file);
  }

  /**
   * Store a new version of a profile, as `proposed`. Creates the profile when
   * it is new, refused past `maxProfiles` in its scope. Keeps at most
   * `maxVersions`: the oldest version that is neither the approved one nor
   * in `protect` is dropped to make room.
   */
  addVersion(options: {
    scope: ProfileScopeKey;
    recipe: ProfileRecipe;
    note?: string;
    chatId: string;
    requestId?: string;
    ownerLabel?: string;
    maxProfiles: number;
    maxVersions: number;
    now?: number;
  }): { profile: StoredProfile; version: StoredVersion } {
    const { scope, recipe } = options;
    const now = options.now ?? Date.now();
    const canonical = canonicalProfileRecipe(recipe);
    // 0 means agents may not propose at all: not a new profile, nor a new version of an old one.
    if (options.maxProfiles === 0)
      throw new ProfileStoreLimitError(
        "profiles",
        "Agents may not propose sandbox profiles on this Callboard (Settings → Sandbox desktop: agent profiles per scope is 0).",
      );
    let profile = this.read(scope, recipe.name);
    if (!profile) {
      const count = this.list(scope).length;
      if (count >= options.maxProfiles)
        throw new ProfileStoreLimitError(
          "profiles",
          options.maxProfiles === 0
            ? "Agents may not propose sandbox profiles on this Callboard (Settings → Sandbox desktop: agent profiles per scope is 0)."
            : `This scope already has ${count} agent-built profile(s), the limit set in Settings → Sandbox desktop. Re-propose one of them instead, or ask the human to remove one.`,
        );
      profile = {
        schema: 1,
        scope,
        name: recipe.name,
        createdAt: now,
        createdBy: options.chatId,
        nextVersion: 1,
        versions: [],
        ...(options.ownerLabel ? { ownerLabel: options.ownerLabel } : {}),
      };
    }
    while (profile.versions.length >= options.maxVersions) {
      const drop = profile.versions.findIndex((v) => v.version !== profile!.current);
      if (drop < 0) throw new ProfileStoreLimitError("versions", "This profile has no version left that could be dropped to make room.");
      profile.versions.splice(drop, 1);
    }
    const version: StoredVersion = {
      version: profile.nextVersion,
      digest: profileRecipeDigest(recipe),
      recipe: canonical,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.note ? { note: options.note.slice(0, NOTE_MAX) } : {}),
      proposedAt: now,
      proposedBy: options.chatId,
      state: "proposed",
    };
    profile.nextVersion += 1;
    profile.versions.push(version);
    this.write(profile);
    return { profile, version };
  }

  /** Read, change and write one profile. Returns the profile as written, or undefined if there is none. */
  update(scope: ProfileScopeKey, name: string, change: (profile: StoredProfile) => void): StoredProfile | undefined {
    const profile = this.read(scope, name);
    if (!profile) return undefined;
    change(profile);
    this.write(profile);
    return profile;
  }

  /** Mark a version approved and in force (the one before it superseded). Throws unless the version exists with that digest. */
  approve(scope: ProfileScopeKey, name: string, version: number, digest: string, approvalId: string, now = Date.now()): StoredProfile {
    const written = this.update(scope, name, (profile) => {
      const target = profile.versions.find((v) => v.version === version);
      if (!target || target.digest !== digest) throw Object.assign(new Error("That version is not stored with that recipe"), { code: "changed" });
      for (const v of profile.versions) if (v.state === "approved" && v !== target) v.state = "superseded";
      target.state = "approved";
      target.approvedAt = now;
      target.approvalId = approvalId;
      profile.current = version;
    });
    if (!written) throw Object.assign(new Error("That profile is not stored any more"), { code: "changed" });
    return written;
  }

  /** Set one version's state (refused, withdrawn) or its build id. A no-op if it is gone. */
  mark(scope: ProfileScopeKey, name: string, version: number, change: Partial<Pick<StoredVersion, "state" | "buildId">>): void {
    try {
      this.update(scope, name, (profile) => {
        const target = profile.versions.find((v) => v.version === version);
        if (!target) return;
        if (change.state) target.state = change.state;
        if (change.buildId) target.buildId = change.buildId;
      });
    } catch {
      /* A version that cannot be marked keeps its old state; nothing depends on it. */
    }
  }

  /** Forget a profile and every version of it. */
  remove(scope: ProfileScopeKey, name: string): boolean {
    const file = this.file(scope, name);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    this.memo.delete(file);
    return true;
  }

  /**
   * Move an approved profile to the global scope: the same versions, the same
   * approved version (so the same recipe digest), with where it came from
   * recorded. Refused when it has no approved version, or a global profile
   * of that name is stored already (the caller checks the built-ins).
   */
  promote(scope: ProfileScopeKey, name: string, now = Date.now()): StoredProfile {
    if (scope === "global") throw Object.assign(new Error("That profile is global already"), { code: "conflict" });
    const profile = this.read(scope, name);
    if (!profile) throw Object.assign(new Error("There is no such agent-built profile"), { code: "not_found" });
    if (profile.current === undefined) throw Object.assign(new Error("It has no approved version to promote"), { code: "conflict" });
    if (this.read("global", name)) throw Object.assign(new Error(`A global profile named ${name} exists already`), { code: "conflict" });
    const promoted: StoredProfile = {
      ...profile,
      scope: "global",
      promoted: { at: now, fromScope: scope, fromVersion: profile.current },
    };
    this.write(promoted);
    this.remove(scope, name);
    return promoted;
  }
}

let store: ProfileStore | undefined;
/** The store under this Callboard's data directory. */
export function getProfileStore(): ProfileStore {
  return (store ??= new ProfileStore());
}
/** Tests: point the store somewhere else (or back, with no argument). */
export function setProfileStoreForTest(next?: ProfileStore): void {
  store = next;
}
