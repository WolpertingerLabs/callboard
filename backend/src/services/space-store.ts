/**
 * Space store — file-backed persistence for spaces (named partitions of the
 * chat list; see shared/types/space.ts for what a space is and is not).
 *
 *   ~/.callboard/spaces/{spaceId}.json   Space
 *
 * One file per space, like workspaces, and for the same reason the writes are
 * deltas: two tabs over remote access is the normal shape, so a whole-list
 * write from one would silently undo the other's edit. {@link updateSpace}
 * merges only the keys a patch names.
 *
 * The default space ("General") is virtual until someone edits it: with no
 * `default.json` on disk it is synthesised, so a fresh install has exactly one
 * space and nothing written.
 *
 * Reads are cached against the directory's mtime. Every write here is a
 * tmp-file rename into the directory, which bumps it, so the cache can never
 * outlive a write made through this module; a hand edit of a file's contents
 * in place is picked up on the next write or daemon restart.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_NAME,
  SPACE_ACCENTS,
  SPACE_FOLDER_RULES_MAX,
  SPACE_INSTRUCTIONS_MAX,
  SPACE_NAME_MAX,
  UI_AGENT_PROVIDER_KINDS,
  normalizePermissions,
  type Space,
  type SpaceDefaults,
  type SpacePatch,
} from "shared";
import { DATA_DIR } from "../utils/paths.js";
import { atomicWriteFileSync } from "../utils/atomic-write.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("space-store");

const spacesDir = join(DATA_DIR, "spaces");

try {
  if (!existsSync(spacesDir)) mkdirSync(spacesDir, { recursive: true });
} catch (err: any) {
  log.error(`Failed to create ${spacesDir}: ${err.message} — spaces will not persist`);
}

export class SpaceValidationError extends Error {}

/** Generated ids (`sp_…`) plus the reserved default. Guards every path join. */
const SPACE_ID_RE = /^(default|sp_[A-Za-z0-9_-]{1,40})$/;

export function isValidSpaceId(id: unknown): id is string {
  return typeof id === "string" && SPACE_ID_RE.test(id);
}

function spaceFilePath(id: string): string | null {
  return isValidSpaceId(id) ? join(spacesDir, `${id}.json`) : null;
}

/** Same refusal class as workspace names: controls and bidi overrides. */
const FORBIDDEN_NAME_CLASS = "[\\u0000-\\u001F\\u007F-\\u009F\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]";
const FORBIDDEN_NAME_CHAR = new RegExp(FORBIDDEN_NAME_CLASS, "u");

const EPOCH = new Date(0).toISOString();

function syntheticDefault(): Space {
  return { id: DEFAULT_SPACE_ID, name: DEFAULT_SPACE_NAME, order: 0, createdAt: EPOCH, updatedAt: EPOCH };
}

let cache: { mtimeMs: number; spaces: Space[] } | null = null;

function readAll(): Space[] {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(spacesDir).mtimeMs;
  } catch {
    /* missing dir: fall through with just the default */
  }
  if (cache && cache.mtimeMs === mtimeMs && mtimeMs !== -1) return cache.spaces;
  const spaces: Space[] = [];
  let sawDefault = false;
  try {
    for (const file of readdirSync(spacesDir)) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5);
      if (!isValidSpaceId(id)) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(spacesDir, file), "utf8"));
        if (!parsed || typeof parsed !== "object" || parsed.id !== id || typeof parsed.name !== "string") continue;
        spaces.push(parsed as Space);
        if (id === DEFAULT_SPACE_ID) sawDefault = true;
      } catch (err: any) {
        log.warn(`Skipping unreadable space file ${file}: ${err.message}`);
      }
    }
  } catch {
    /* missing dir */
  }
  if (!sawDefault) spaces.push(syntheticDefault());
  spaces.sort((a, b) => a.order - b.order || (a.id === DEFAULT_SPACE_ID ? -1 : b.id === DEFAULT_SPACE_ID ? 1 : a.createdAt.localeCompare(b.createdAt)));
  cache = { mtimeMs, spaces };
  return spaces;
}

function save(space: Space): void {
  const file = spaceFilePath(space.id);
  if (!file) throw new SpaceValidationError(`Invalid space id: ${space.id}`);
  mkdirSync(spacesDir, { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(space, null, 2), { fsync: false });
  cache = null;
}

// ── Reads ───────────────────────────────────────────────────────────

/** Every space, switcher order. Archived ones only when asked for. */
export function listSpaces(opts: { includeArchived?: boolean } = {}): Space[] {
  const all = readAll();
  return opts.includeArchived ? [...all] : all.filter((s) => !s.archived);
}

export function getSpace(id: string): Space | null {
  return readAll().find((s) => s.id === id) ?? null;
}

/** Ids of every space that exists, archived included. */
export function knownSpaceIds(): Set<string> {
  return new Set(readAll().map((s) => s.id));
}

/**
 * The space a stored stamp actually means: the stamp when it names a space
 * that exists, the default otherwise. A chat whose space was deleted out from
 * under it (hand-edited files — the route refuses to orphan) falls back to
 * General rather than disappearing from every listing.
 */
export function normalizeSpaceId(raw: unknown, known: Set<string> = knownSpaceIds()): string {
  return typeof raw === "string" && known.has(raw) ? raw : DEFAULT_SPACE_ID;
}

// ── Folder rules ────────────────────────────────────────────────────

function expandHome(pattern: string): string {
  if (pattern === "~") return homedir();
  if (pattern.startsWith("~/")) return join(homedir(), pattern.slice(2));
  return pattern;
}

/**
 * Compile one folder rule. A plain path means "this directory and everything
 * under it"; `*` matches within one path segment, `**` across segments, and a
 * trailing `/**` also matches the directory itself.
 */
export function compileFolderRule(rule: string): (folder: string) => boolean {
  const pattern = expandHome(rule.trim()).replace(/\/+$/, "") || "/";
  if (!/[*?]/.test(pattern)) return (folder) => folder === pattern || folder.startsWith(pattern === "/" ? "/" : `${pattern}/`);
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const re = new RegExp(`^${source}$`);
  const dirSelf = pattern.endsWith("/**") ? pattern.slice(0, -3) : null;
  return (folder) => re.test(folder) || folder === dirSelf;
}

let rulesCache: { spaces: Space[]; rules: { spaceId: string; test: (folder: string) => boolean }[] } | null = null;

/**
 * The space folder rules assign to `folder`, or the default when none match.
 * First match in switcher order wins; archived spaces' rules are inert.
 */
export function spaceForFolder(folder: string | null | undefined): string {
  const spaces = readAll();
  if (!rulesCache || rulesCache.spaces !== spaces) {
    const rules: { spaceId: string; test: (folder: string) => boolean }[] = [];
    for (const space of spaces) {
      if (space.archived || space.id === DEFAULT_SPACE_ID) continue;
      for (const rule of space.folderRules ?? []) {
        try {
          rules.push({ spaceId: space.id, test: compileFolderRule(rule) });
        } catch {
          /* a broken rule matches nothing */
        }
      }
    }
    rulesCache = { spaces, rules };
  }
  if (!folder) return DEFAULT_SPACE_ID;
  return rulesCache.rules.find((r) => r.test(folder))?.spaceId ?? DEFAULT_SPACE_ID;
}

// ── Validation ──────────────────────────────────────────────────────

function validName(raw: unknown): string {
  if (typeof raw !== "string") throw new SpaceValidationError("name must be a string");
  const name = raw.trim();
  if (!name) throw new SpaceValidationError("A space name is required");
  if (name.length > SPACE_NAME_MAX) throw new SpaceValidationError(`A space name is limited to ${SPACE_NAME_MAX} characters`);
  if (FORBIDDEN_NAME_CHAR.test(name)) throw new SpaceValidationError("A space name may not contain control or text-direction characters");
  return name;
}

function validStringList(raw: unknown, field: string, max: number, itemMax = 512): string[] {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) throw new SpaceValidationError(`${field} must be an array of strings`);
  const list = [...new Set((raw as string[]).map((v) => v.trim()).filter(Boolean))];
  if (list.length > max) throw new SpaceValidationError(`${field} is limited to ${max} entries`);
  if (list.some((v) => v.length > itemMax || FORBIDDEN_NAME_CHAR.test(v))) throw new SpaceValidationError(`${field} contains an invalid entry`);
  return list;
}

const RECENT_DIRECTORIES_MAX = 10;
const EFFORTS = new Set(["persistent", "ultra", "max", "xhigh", "high", "medium", "low", "minimal", "none"]);

function applyDefaults(current: SpaceDefaults | undefined, patch: NonNullable<SpacePatch["defaults"]>): SpaceDefaults | undefined {
  if (typeof patch !== "object" || Array.isArray(patch)) throw new SpaceValidationError("defaults must be an object");
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete next[key];
      continue;
    }
    switch (key) {
      case "provider":
        if (!(UI_AGENT_PROVIDER_KINDS as readonly string[]).includes(value as string))
          throw new SpaceValidationError("defaults.provider is not a known provider");
        next.provider = value;
        break;
      case "model":
        if (typeof value !== "string" || value.length > 256) throw new SpaceValidationError("defaults.model must be a string");
        if (value.trim()) next.model = value.trim();
        else delete next.model;
        break;
      case "effort":
        if (typeof value !== "string" || !EFFORTS.has(value)) throw new SpaceValidationError("defaults.effort is not a known effort level");
        next.effort = value;
        break;
      case "defaultPermissions":
        if (typeof value !== "object" || Array.isArray(value)) throw new SpaceValidationError("defaults.defaultPermissions must be an object");
        next.defaultPermissions = normalizePermissions(value);
        break;
      case "worktreeByDefault":
        if (typeof value !== "boolean") throw new SpaceValidationError("defaults.worktreeByDefault must be a boolean");
        next.worktreeByDefault = value;
        break;
      case "recentDirectories": {
        if (!Array.isArray(value)) throw new SpaceValidationError("defaults.recentDirectories must be an array");
        const seen = new Set<string>();
        const dirs: { path: string; lastUsed: string }[] = [];
        for (const entry of value) {
          if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || !entry.path.startsWith("/")) continue;
          if (seen.has(entry.path)) continue;
          seen.add(entry.path);
          dirs.push({ path: entry.path.slice(0, 4096), lastUsed: typeof entry.lastUsed === "string" ? entry.lastUsed : new Date().toISOString() });
        }
        next.recentDirectories = dirs.slice(0, RECENT_DIRECTORIES_MAX);
        break;
      }
      default:
        throw new SpaceValidationError(`Unknown default "${key}"`);
    }
  }
  return Object.keys(next).length ? (next as SpaceDefaults) : undefined;
}

/** Apply a delta to a space. Absent keys untouched; `null` clears. Pure. */
export function applySpacePatch(space: Space, patch: SpacePatch): Space {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new SpaceValidationError("Body must be an object");
  const next: Space = { ...space };
  const clear = (key: keyof Space) => delete (next as unknown as Record<string, unknown>)[key];
  if (patch.name !== undefined) next.name = validName(patch.name);
  if (patch.emoji !== undefined) {
    if (patch.emoji === null || patch.emoji === "") clear("emoji");
    else if (typeof patch.emoji !== "string" || patch.emoji.length > 16 || FORBIDDEN_NAME_CHAR.test(patch.emoji))
      throw new SpaceValidationError("emoji must be a short string");
    else next.emoji = patch.emoji;
  }
  if (patch.color !== undefined) {
    if (patch.color === null) clear("color");
    else if (!(SPACE_ACCENTS as readonly string[]).includes(patch.color)) throw new SpaceValidationError(`color must be one of ${SPACE_ACCENTS.join(", ")}`);
    else next.color = patch.color;
  }
  if (patch.order !== undefined) {
    if (typeof patch.order !== "number" || !Number.isFinite(patch.order)) throw new SpaceValidationError("order must be a number");
    next.order = patch.order;
  }
  if (patch.archived !== undefined) {
    if (typeof patch.archived !== "boolean") throw new SpaceValidationError("archived must be a boolean");
    if (patch.archived && space.id === DEFAULT_SPACE_ID) throw new SpaceValidationError("The default space cannot be archived");
    if (patch.archived) next.archived = true;
    else clear("archived");
  }
  if (patch.folderRules !== undefined) {
    if (patch.folderRules === null) clear("folderRules");
    else {
      const rules = validStringList(patch.folderRules, "folderRules", SPACE_FOLDER_RULES_MAX);
      if (rules.length) next.folderRules = rules;
      else clear("folderRules");
    }
  }
  if (patch.defaults !== undefined) {
    const defaults = patch.defaults === null ? undefined : applyDefaults(space.defaults, patch.defaults);
    if (defaults) next.defaults = defaults;
    else clear("defaults");
  }
  if (patch.instructions !== undefined) {
    if (patch.instructions === null) clear("instructions");
    else if (typeof patch.instructions !== "string") throw new SpaceValidationError("instructions must be a string");
    else if (patch.instructions.length > SPACE_INSTRUCTIONS_MAX)
      throw new SpaceValidationError(`instructions are limited to ${SPACE_INSTRUCTIONS_MAX} characters — they ride on every chat's system prompt`);
    else if (patch.instructions.trim()) next.instructions = patch.instructions.trim();
    else clear("instructions");
  }
  if (patch.folderRulesAdd !== undefined) {
    const added = validStringList(patch.folderRulesAdd, "folderRulesAdd", SPACE_FOLDER_RULES_MAX);
    const rules = [...new Set([...(next.folderRules ?? []), ...added])];
    if (rules.length > SPACE_FOLDER_RULES_MAX) throw new SpaceValidationError(`folderRules is limited to ${SPACE_FOLDER_RULES_MAX} entries`);
    if (rules.length) next.folderRules = rules;
  }
  if (patch.removeRecentDirectory !== undefined) {
    if (typeof patch.removeRecentDirectory !== "string") throw new SpaceValidationError("removeRecentDirectory must be a path");
    const remaining = (next.defaults?.recentDirectories ?? []).filter((d) => d.path !== patch.removeRecentDirectory);
    const defaults: SpaceDefaults = { ...(next.defaults ?? {}), recentDirectories: remaining };
    if (!remaining.length) delete defaults.recentDirectories;
    if (Object.keys(defaults).length) next.defaults = defaults;
    else clear("defaults");
  }
  if (patch.agentScope !== undefined) {
    if (patch.agentScope === null) clear("agentScope");
    else {
      if (typeof patch.agentScope !== "object" || Array.isArray(patch.agentScope)) throw new SpaceValidationError("agentScope must be an object");
      const scope: Record<string, string[]> = { ...(space.agentScope ?? {}) } as Record<string, string[]>;
      for (const key of ["plugins", "skills"] as const) {
        const value = patch.agentScope[key];
        if (value === undefined) continue;
        if (value === null) delete scope[key];
        else scope[key] = validStringList(value, `agentScope.${key}`, 200, 256);
      }
      if (Object.keys(scope).length) next.agentScope = scope;
      else clear("agentScope");
    }
  }
  for (const [op, add] of [
    [patch.agentScopeAdd, true],
    [patch.agentScopeRemove, false],
  ] as const) {
    if (op === undefined) continue;
    if (!op || typeof op !== "object" || Array.isArray(op)) throw new SpaceValidationError("agentScope delta must be an object");
    const scope: Record<string, string[]> = { ...(next.agentScope ?? {}) } as Record<string, string[]>;
    for (const key of ["plugins", "skills"] as const) {
      const entries = op[key];
      if (entries === undefined) continue;
      const items = validStringList(entries, `agentScope.${key}`, 200, 256);
      // Unrestricted admits everything already: nothing to add, and removing
      // from it would need the full list this delta deliberately does not carry.
      if (!scope[key]) continue;
      scope[key] = add ? [...new Set([...scope[key], ...items])] : scope[key].filter((x) => !items.includes(x));
    }
    if (Object.keys(scope).length) next.agentScope = scope;
  }
  return next;
}

// ── Writes ──────────────────────────────────────────────────────────

export function createSpace(patch: SpacePatch & { name: string }): Space {
  const now = new Date().toISOString();
  const maxOrder = readAll().reduce((m, s) => Math.max(m, s.order), 0);
  const base: Space = {
    id: `sp_${randomBytes(6).toString("base64url")}`,
    name: validName(patch.name),
    order: maxOrder + 1,
    createdAt: now,
    updatedAt: now,
  };
  const space = applySpacePatch(base, { ...patch, archived: undefined });
  space.updatedAt = now;
  save(space);
  log.info(`Created space ${space.id} ("${space.name}")`);
  return space;
}

export function updateSpace(id: string, patch: SpacePatch): Space | null {
  const current = getSpace(id);
  if (!current) return null;
  const next = applySpacePatch(current, patch);
  next.updatedAt = new Date().toISOString();
  if (next.createdAt === EPOCH) next.createdAt = next.updatedAt;
  save(next);
  return next;
}

/** Remove a space's file. Callers move or check its chats first. */
export function deleteSpaceRecord(id: string): boolean {
  if (id === DEFAULT_SPACE_ID) throw new SpaceValidationError("The default space cannot be deleted");
  const file = spaceFilePath(id);
  if (!file || !existsSync(file)) return false;
  rmSync(file, { force: true });
  cache = null;
  log.info(`Deleted space ${id}`);
  return true;
}

/**
 * Rewrite `order` from a full or partial id list in one write pass: listed
 * spaces take 0..n-1 in that order, everything unlisted follows in its current
 * order. Unknown ids are ignored. Only records whose order changes are written.
 */
export function reorderSpaces(ids: string[]): void {
  // A repeated id would otherwise be placed twice and leave a gap.
  ids = [...new Set(ids)];
  const all = readAll();
  const listed = ids.map((id) => all.find((s) => s.id === id)).filter((s): s is Space => !!s);
  const rest = all.filter((s) => !ids.includes(s.id));
  const now = new Date().toISOString();
  [...listed, ...rest].forEach((space, order) => {
    if (space.order === order) return;
    save({ ...space, order, updatedAt: now, ...(space.createdAt === EPOCH && { createdAt: now }) });
  });
}

/**
 * Push a folder onto a space's recent-directory list (most recent first).
 * Skips archived spaces: nobody starts a chat in one on purpose, and a list
 * that keeps growing there is noise when it is unarchived.
 */
export function touchSpaceRecentDirectory(id: string, path: string): void {
  const space = getSpace(id);
  if (!space || space.archived || !path.startsWith("/")) return;
  const existing = (space.defaults?.recentDirectories ?? []).filter((d) => d.path !== path);
  updateSpace(id, { defaults: { recentDirectories: [{ path, lastUsed: new Date().toISOString() }, ...existing] } });
}

/** Test seam: drop the read cache. */
export function _resetSpaceStoreCache(): void {
  cache = null;
  rulesCache = null;
}
