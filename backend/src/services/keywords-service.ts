/**
 * Injectable keywords — user-authored prompt snippets the composer expands
 * inline when the user types `$name`.
 *
 * Storage is a single JSON file:
 *
 *   ~/.callboard/keywords.json   ← { version: 1, keywords: [...] }
 *
 * Deliberately *not* the directory-of-markdown layout
 * {@link ../services/custom-skills-service.ts custom skills} use. That layout
 * exists because two external loaders (the Claude Code plugin loader and pi's
 * skill scanner) read those files directly and dictate their on-disk shape.
 * Keywords have exactly one consumer — the browser, through this service's
 * routes — and expand to plain text before anything is sent, so nothing
 * downstream ever learns keywords exist. One file is the whole requirement.
 *
 * Keywords are global to the install: not per-directory, not per-workspace.
 * Nothing here keys on `cwd` or `workspaceId`, so the keying rule in
 * `.claude/CLAUDE.md` has no side to put this on — it is install-wide config,
 * like themes.
 *
 * A missing or corrupt file is never fatal. Reads log and fall back to empty so
 * a hand-edited `keywords.json` with a stray comma degrades the autocomplete
 * rather than taking the daemon down with it.
 *
 * That tolerance has one hard limit, and it is the whole point of `readStore`
 * reporting `lossy`: **a read that did not understand everything on disk must
 * never be written back over the original.** Degrading to `[]` is a fine way to
 * *serve* a broken file; it is a catastrophic way to *save* one, because the
 * next `createKeyword` would persist the empty list and the user's keywords
 * would be gone with no error and no copy. Every write therefore preserves the
 * existing file first whenever anything about it was not fully represented in
 * what the read returned — see {@link KeywordsService.preserve}.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, copyFileSync, realpathSync } from "fs";
import { join, dirname } from "path";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";
import type { Keyword, KeywordsFile, KeywordCreateInput, KeywordUpdateInput } from "shared/types/index.js";

const log = createLogger("keywords");

const KEYWORDS_FILE = join(DATA_DIR, "keywords.json");

const NAME_MAX = 64;
const DESCRIPTION_MAX = 512;
const BODY_MAX = 32 * 1024;
const KEYWORD_COUNT_MAX = 500;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Kebab-case a display name into a keyword slug. Throws if nothing usable
 * remains.
 *
 * The slug is what the user types after `$`, so it is restricted to the same
 * character class the composer's trigger scanner treats as part of a token
 * (`frontend/src/utils/keywordTrigger.ts`) minus uppercase and `_` — a keyword
 * the trigger could not finish matching would be unreachable.
 */
export function slugifyKeywordName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_MAX)
    .replace(/-+$/g, "");
  if (!slug || !NAME_RE.test(slug)) {
    throw new Error(`Keyword name "${name}" contains no usable characters (a-z, 0-9)`);
  }
  return slug;
}

function validateDescription(description: string): string {
  const desc = description.replace(/\s+/g, " ").trim();
  if (desc.length > DESCRIPTION_MAX) {
    throw new Error(`Keyword description must be ${DESCRIPTION_MAX} characters or fewer`);
  }
  return desc;
}

/**
 * Validate a keyword body.
 *
 * Only the ends are trimmed: interior whitespace, blank lines and indentation
 * are the point of a multi-line snippet, and the body is pasted verbatim.
 */
function validateBody(body: string): string {
  const text = body.trim();
  if (!text) throw new Error("Keyword body is required");
  if (text.length > BODY_MAX) {
    throw new Error(`Keyword body must be ${BODY_MAX} characters or fewer`);
  }
  return text;
}

/**
 * What a read recovered, and whether it recovered *everything*.
 *
 * `lossy` is not a diagnostic — it is the input to the write path's decision
 * about whether overwriting the file would destroy something. It is true
 * whenever anything on disk is not represented in `keywords`: the file would
 * not parse, parsed to the wrong shape, could not be read at all, parsed fine
 * but contained entries that were dropped, or carried fields this version does
 * not know about.
 *
 * That last clause is the easy one to under-implement, because nothing visibly
 * breaks without it. `keywords.json` is documented as hand-editable, and the
 * population that hand-edits a config file is the population that annotates it;
 * a `"note"` key or a per-keyword `"tags"` array would be silently deleted by
 * the next save. An unrecognized `version` is the same hazard arriving from the
 * other direction — a downgrade after a future v2 format would rewrite the
 * store as v1 and drop every v2 field. Reading such a store still works
 * normally; only *overwriting* it takes a copy first.
 */
interface StoreRead {
  keywords: Keyword[];
  lossy: boolean;
}

/**
 * The store could not be saved because the file already there could not be
 * understood *and* could not be copied aside first.
 *
 * A distinct type because it is the one failure the user can actually act on,
 * and because "500 Failed to create keyword" tells them nothing: the keyword
 * they typed is fine, their store is broken, nothing was lost, and the fix is a
 * `mv`. The routes translate this into that sentence rather than a stack trace.
 */
export class KeywordStoreUnwritableError extends Error {
  constructor(
    readonly path: string,
    readonly cause: Error,
  ) {
    super(
      `Your keywords file could not be read as valid JSON, and a backup copy of it could not be written either ` +
        `(${cause.message}). Nothing was changed and nothing was lost. Move or repair ${path}, then try again.`,
    );
    this.name = "KeywordStoreUnwritableError";
  }
}

/** The store version this build writes and fully understands. */
const STORE_VERSION = 1;

/** Top-level keys of a store this version knows how to round-trip. */
const KNOWN_STORE_KEYS = new Set(["version", "keywords"]);

/** Keys of a single keyword this version knows how to round-trip. */
const KNOWN_KEYWORD_KEYS = new Set(["name", "description", "body", "createdAt", "updatedAt"]);

class KeywordsService {
  /**
   * Read and parse the store, tolerating every way the file can be unusable.
   *
   * Returns the keywords that survived: a file that is missing, unreadable,
   * not JSON, or JSON of the wrong shape all yield `[]`, and individual entries
   * that fail their shape check are dropped rather than poisoning the list.
   * Sorted here, once, so every caller gets the same order without re-sorting —
   * a hand-edited file need not be in any order to begin with.
   */
  private readStore(): StoreRead {
    if (!existsSync(KEYWORDS_FILE)) return { keywords: [], lossy: false };

    let text: string;
    try {
      text = readFileSync(KEYWORDS_FILE, "utf8");
    } catch (err) {
      // Unreadable is the most dangerous case, not the least: we know nothing
      // about the contents, so a write must not assume there is nothing to lose.
      log.error(`Failed to read ${KEYWORDS_FILE} — treating as empty: ${(err as Error).message}`);
      return { keywords: [], lossy: true };
    }

    // A blank file is indistinguishable from a missing one and holds nothing
    // worth preserving, so it is not lossy.
    if (!text.trim()) return { keywords: [], lossy: false };

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: any) {
      log.error(`Failed to parse ${KEYWORDS_FILE} — treating as empty: ${err.message}`);
      return { keywords: [], lossy: true };
    }
    const raw = (parsed as KeywordsFile | null)?.keywords;
    if (!Array.isArray(raw)) {
      log.error(`${KEYWORDS_FILE} has no keywords array — treating as empty`);
      return { keywords: [], lossy: true };
    }

    // Anything this build would not write back. A *missing* version is not
    // counted: an absent key is not data, and a hand-written file without one
    // loses nothing by being given the current version on save.
    const store = parsed as Record<string, unknown>;
    const unknownStoreKeys = Object.keys(store).filter((k) => !KNOWN_STORE_KEYS.has(k));
    const foreignVersion = store.version !== undefined && store.version !== STORE_VERSION;
    let unknownEntryKeys = 0;

    const seen = new Set<string>();
    const keywords: Keyword[] = [];
    // Counted apart, because they are different faults with different fixes:
    // a malformed entry is a typo to correct, a duplicate is a shadowed keyword
    // whose second copy the user will never see. Lumping them together reported
    // a clean-but-duplicated file as "malformed".
    let malformed = 0;
    let duplicates = 0;
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") {
        malformed++;
        continue;
      }
      const { name, description, body, createdAt, updatedAt } = entry as Partial<Keyword>;
      if (typeof name !== "string" || !NAME_RE.test(name) || typeof body !== "string" || !body) {
        malformed++;
        continue;
      }
      if (seen.has(name)) {
        duplicates++;
        continue;
      }
      unknownEntryKeys += Object.keys(entry).filter((k) => !KNOWN_KEYWORD_KEYS.has(k)).length;
      seen.add(name);
      keywords.push({
        name,
        description: typeof description === "string" ? description : "",
        body,
        createdAt: typeof createdAt === "string" ? createdAt : new Date(0).toISOString(),
        updatedAt: typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString(),
      });
    }
    if (malformed > 0) {
      log.warn(`Dropped ${malformed} malformed keyword entr${malformed === 1 ? "y" : "ies"} from ${KEYWORDS_FILE}`);
    }
    if (duplicates > 0) {
      log.warn(`Ignored ${duplicates} duplicate keyword name${duplicates === 1 ? "" : "s"} in ${KEYWORDS_FILE} — the first of each wins`);
    }
    if (foreignVersion) {
      log.warn(`${KEYWORDS_FILE} declares version ${JSON.stringify(store.version)}, but this build writes version ${STORE_VERSION}`);
    }
    if (unknownStoreKeys.length > 0 || unknownEntryKeys > 0) {
      log.warn(
        `${KEYWORDS_FILE} carries fields this build does not know about` +
          `${unknownStoreKeys.length > 0 ? ` (top-level: ${unknownStoreKeys.join(", ")})` : ""}` +
          `${unknownEntryKeys > 0 ? ` (${unknownEntryKeys} on individual keywords)` : ""}` +
          ` — they are readable but would not survive a save, so one will be kept`,
      );
    }

    keywords.sort((a, b) => a.name.localeCompare(b.name));
    return {
      keywords,
      lossy: malformed > 0 || duplicates > 0 || foreignVersion || unknownStoreKeys.length > 0 || unknownEntryKeys > 0,
    };
  }

  private read(): Keyword[] {
    return this.readStore().keywords;
  }

  /**
   * Copy the file aside before a write that would otherwise destroy it.
   *
   * Called only when the read that produced the new list did not fully
   * understand the old one. Chosen over refusing the write outright: refusing
   * is safe for the data but leaves the user unable to add a keyword until they
   * hand-repair a JSON file they may not know exists, discoverable only through
   * a failed save. A copy is strictly non-destructive, keeps the feature
   * working, and names the backup in the log — recovery is a `mv` away.
   *
   * Throws {@link KeywordStoreUnwritableError} if the copy fails. If the bytes
   * cannot be preserved they must not be overwritten; a failed create is
   * recoverable, a deleted store is not. The typed error is what lets the
   * routes tell the user their *store* is the problem rather than their input.
   */
  private preserve(target: string): void {
    if (!existsSync(target)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let backup = `${target}.corrupt-${stamp}`;
    for (let i = 2; existsSync(backup); i++) backup = `${target}.corrupt-${stamp}-${i}`;
    try {
      copyFileSync(target, backup);
    } catch (err) {
      log.error(`${target} could not be fully parsed AND could not be copied aside — refusing to overwrite it: ${(err as Error).message}`);
      throw new KeywordStoreUnwritableError(target, err as Error);
    }
    log.error(`${target} could not be fully parsed; the original was copied to ${backup} before being rewritten`);
  }

  /**
   * The path a write must actually land on.
   *
   * `keywords.json` may well be a symlink — into a dotfiles repo, a synced
   * folder — and this write finishes with a rename, which would replace the
   * *link* with a regular file and strand the target holding stale data.
   * Resolving once, here, also puts the temp file beside the real target, which
   * is what keeps the rename atomic in the first place: `rename(2)` across
   * filesystems fails outright.
   *
   * Falls back to the configured path when it does not resolve — overwhelmingly
   * because the file does not exist yet, which is the first-run case.
   */
  private storePath(): string {
    try {
      return realpathSync(KEYWORDS_FILE);
    } catch {
      return KEYWORDS_FILE;
    }
  }

  /**
   * Write the store atomically — temp file then rename — so a crash mid-write
   * leaves the previous list intact rather than a truncated file the next read
   * would discard entirely.
   *
   * `preserveExisting` comes from the {@link StoreRead.lossy} flag of the read
   * this write is based on. Callers must thread it through: it is the only
   * thing standing between a stray comma and total data loss.
   */
  private write(keywords: Keyword[], preserveExisting: boolean): void {
    const target = this.storePath();
    if (preserveExisting) this.preserve(target);
    // Sorted on disk as well as in memory, because the file is meant to be
    // hand-editable and a human reading it should find it in an order.
    const payload: KeywordsFile = { version: STORE_VERSION, keywords: [...keywords].sort((a, b) => a.name.localeCompare(b.name)) };
    mkdirSync(dirname(target), { recursive: true });
    // Process-scoped temp name: two daemons sharing a data dir would otherwise
    // write the same path and rename each other's half-written file into place.
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      renameSync(tmp, target);
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // best-effort cleanup — the original file is what matters
      }
      throw err;
    }
  }

  listKeywords(): Keyword[] {
    return this.read();
  }

  getKeyword(name: string): Keyword | null {
    if (!NAME_RE.test(name)) return null;
    return this.read().find((k) => k.name === name) ?? null;
  }

  createKeyword(input: KeywordCreateInput): Keyword {
    const name = slugifyKeywordName(input.name);
    const description = validateDescription(input.description ?? "");
    const body = validateBody(input.body);

    const { keywords, lossy } = this.readStore();
    if (keywords.some((k) => k.name === name)) {
      throw new Error(`Keyword "${name}" already exists`);
    }
    if (keywords.length >= KEYWORD_COUNT_MAX) {
      throw new Error(`Keyword limit reached — ${KEYWORD_COUNT_MAX} keywords maximum`);
    }

    const now = new Date().toISOString();
    const keyword: Keyword = { name, description, body, createdAt: now, updatedAt: now };
    this.write([...keywords, keyword], lossy);
    log.info(`Created keyword "${name}"`);
    return keyword;
  }

  updateKeyword(name: string, updates: KeywordUpdateInput): Keyword {
    const { keywords, lossy } = this.readStore();
    const existing = keywords.find((k) => k.name === name);
    if (!existing) throw new Error(`Keyword "${name}" not found`);

    const newName = updates.name !== undefined ? slugifyKeywordName(updates.name) : name;
    const description = validateDescription(updates.description ?? existing.description);
    const body = validateBody(updates.body ?? existing.body);

    if (newName !== name && keywords.some((k) => k.name === newName)) {
      throw new Error(`Keyword "${newName}" already exists`);
    }

    const keyword: Keyword = {
      name: newName,
      description,
      body,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.write(
      keywords.map((k) => (k.name === name ? keyword : k)),
      lossy,
    );
    log.info(`Updated keyword "${newName}"${newName !== name ? ` (renamed from "${name}")` : ""}`);
    return keyword;
  }

  deleteKeyword(name: string): void {
    const { keywords, lossy } = this.readStore();
    if (!keywords.some((k) => k.name === name)) {
      throw new Error(`Keyword "${name}" not found`);
    }
    this.write(
      keywords.filter((k) => k.name !== name),
      lossy,
    );
    log.info(`Deleted keyword "${name}"`);
  }
}

export const keywordsService = new KeywordsService();
