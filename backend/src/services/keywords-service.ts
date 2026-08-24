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
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
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

class KeywordsService {
  /**
   * Read and parse the store, tolerating every way the file can be unusable.
   *
   * Returns the keywords that survived: a file that is missing, unreadable,
   * not JSON, or JSON of the wrong shape all yield `[]`, and individual entries
   * that fail their shape check are dropped rather than poisoning the list.
   */
  private read(): Keyword[] {
    if (!existsSync(KEYWORDS_FILE)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(KEYWORDS_FILE, "utf8"));
    } catch (err: any) {
      log.error(`Failed to parse ${KEYWORDS_FILE} — treating as empty: ${err.message}`);
      return [];
    }
    const raw = (parsed as KeywordsFile | null)?.keywords;
    if (!Array.isArray(raw)) {
      log.error(`${KEYWORDS_FILE} has no keywords array — treating as empty`);
      return [];
    }
    const seen = new Set<string>();
    const keywords: Keyword[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const { name, description, body, createdAt, updatedAt } = entry as Partial<Keyword>;
      if (typeof name !== "string" || !NAME_RE.test(name) || typeof body !== "string" || !body) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      keywords.push({
        name,
        description: typeof description === "string" ? description : "",
        body,
        createdAt: typeof createdAt === "string" ? createdAt : new Date(0).toISOString(),
        updatedAt: typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString(),
      });
    }
    if (keywords.length !== raw.length) {
      log.warn(`Dropped ${raw.length - keywords.length} malformed keyword entr${raw.length - keywords.length === 1 ? "y" : "ies"}`);
    }
    return keywords;
  }

  /**
   * Write the store atomically — temp file then rename — so a crash mid-write
   * leaves the previous list intact rather than a truncated file the next read
   * would discard entirely.
   */
  private write(keywords: Keyword[]): void {
    const payload: KeywordsFile = { version: 1, keywords: [...keywords].sort((a, b) => a.name.localeCompare(b.name)) };
    mkdirSync(dirname(KEYWORDS_FILE), { recursive: true });
    const tmp = `${KEYWORDS_FILE}.tmp`;
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
    return this.read().sort((a, b) => a.name.localeCompare(b.name));
  }

  getKeyword(name: string): Keyword | null {
    if (!NAME_RE.test(name)) return null;
    return this.read().find((k) => k.name === name) ?? null;
  }

  createKeyword(input: KeywordCreateInput): Keyword {
    const name = slugifyKeywordName(input.name);
    const description = validateDescription(input.description ?? "");
    const body = validateBody(input.body);

    const keywords = this.read();
    if (keywords.some((k) => k.name === name)) {
      throw new Error(`Keyword "${name}" already exists`);
    }
    if (keywords.length >= KEYWORD_COUNT_MAX) {
      throw new Error(`Keyword limit reached — ${KEYWORD_COUNT_MAX} keywords maximum`);
    }

    const now = new Date().toISOString();
    const keyword: Keyword = { name, description, body, createdAt: now, updatedAt: now };
    this.write([...keywords, keyword]);
    log.info(`Created keyword "${name}"`);
    return keyword;
  }

  updateKeyword(name: string, updates: KeywordUpdateInput): Keyword {
    const keywords = this.read();
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
    this.write(keywords.map((k) => (k.name === name ? keyword : k)));
    log.info(`Updated keyword "${newName}"${newName !== name ? ` (renamed from "${name}")` : ""}`);
    return keyword;
  }

  deleteKeyword(name: string): void {
    const keywords = this.read();
    if (!keywords.some((k) => k.name === name)) {
      throw new Error(`Keyword "${name}" not found`);
    }
    this.write(keywords.filter((k) => k.name !== name));
    log.info(`Deleted keyword "${name}"`);
  }
}

export const keywordsService = new KeywordsService();
