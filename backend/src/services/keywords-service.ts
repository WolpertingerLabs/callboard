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
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, copyFileSync } from "fs";
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
 * whenever any byte on disk is not represented in `keywords`: the file would
 * not parse, parsed to the wrong shape, could not be read at all, or parsed
 * fine but contained entries that were dropped.
 */
interface StoreRead {
  keywords: Keyword[];
  lossy: boolean;
}

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

    keywords.sort((a, b) => a.name.localeCompare(b.name));
    return { keywords, lossy: malformed > 0 || duplicates > 0 };
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
   * Throws if the copy fails. If the bytes cannot be preserved they must not be
   * overwritten; a failed create is recoverable, a deleted store is not.
   */
  private preserve(): void {
    if (!existsSync(KEYWORDS_FILE)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let backup = `${KEYWORDS_FILE}.corrupt-${stamp}`;
    for (let i = 2; existsSync(backup); i++) backup = `${KEYWORDS_FILE}.corrupt-${stamp}-${i}`;
    copyFileSync(KEYWORDS_FILE, backup);
    log.error(`${KEYWORDS_FILE} could not be fully parsed; the original was copied to ${backup} before being rewritten`);
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
    if (preserveExisting) this.preserve();
    // Sorted on disk as well as in memory, because the file is meant to be
    // hand-editable and a human reading it should find it in an order.
    const payload: KeywordsFile = { version: 1, keywords: [...keywords].sort((a, b) => a.name.localeCompare(b.name)) };
    mkdirSync(dirname(KEYWORDS_FILE), { recursive: true });
    // Process-scoped temp name: two daemons sharing a data dir would otherwise
    // write the same path and rename each other's half-written file into place.
    const tmp = `${KEYWORDS_FILE}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      renameSync(tmp, KEYWORDS_FILE);
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
