/**
 * Unit tests for the keywords service — CRUD over the single JSON store, the
 * slug rules, the caps, and every way `keywords.json` can be unusable.
 *
 * The recovery cases are the ones that matter most. This file is hand-editable
 * by design (it is one small JSON document in the user's home directory), so a
 * stray comma or a half-written array is a realistic state, and the daemon has
 * to survive it. "Survive" here means: log, treat as empty, and keep serving —
 * never throw out of a read.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, chmodSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DATA_DIR is resolved from this env var when utils/paths.js first loads, so
// it must be set before the service module is imported (hence dynamic import).
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-keywords-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { keywordsService, slugifyKeywordName, KeywordStoreUnwritableError } = await import("./keywords-service.js");

const KEYWORDS_FILE = join(tmpRoot, "keywords.json");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Every file the service has left in the data dir besides the store itself. */
const strays = () => readdirSync(tmpRoot).filter((f) => f !== "keywords.json");
const backups = () => strays().filter((f) => f.startsWith("keywords.json.corrupt-"));

beforeEach(() => {
  for (const file of readdirSync(tmpRoot)) rmSync(join(tmpRoot, file), { force: true });
});

describe("slugifyKeywordName", () => {
  it("kebab-cases display names", () => {
    expect(slugifyKeywordName("Review Checklist")).toBe("review-checklist");
    expect(slugifyKeywordName("  PR -> Body!  ")).toBe("pr-body");
    expect(slugifyKeywordName("already-kebab")).toBe("already-kebab");
    expect(slugifyKeywordName("Standup2")).toBe("standup2");
  });

  it("rejects names with no usable characters", () => {
    expect(() => slugifyKeywordName("!!!")).toThrow(/no usable characters/);
    expect(() => slugifyKeywordName("")).toThrow(/no usable characters/);
    expect(() => slugifyKeywordName("   ")).toThrow(/no usable characters/);
  });
});

describe("CRUD", () => {
  it("creates a keyword and writes the versioned store", () => {
    const keyword = keywordsService.createKeyword({
      name: "Review Checklist",
      description: "What to look at in review",
      body: "Check the tests and the types.",
    });
    expect(keyword.name).toBe("review-checklist");
    expect(keyword.description).toBe("What to look at in review");
    expect(keyword.body).toBe("Check the tests and the types.");
    expect(keyword.createdAt).toBe(keyword.updatedAt);

    const raw = JSON.parse(readFileSync(KEYWORDS_FILE, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.keywords).toHaveLength(1);
  });

  it("treats the description as optional", () => {
    const keyword = keywordsService.createKeyword({ name: "bare", body: "text" });
    expect(keyword.description).toBe("");
  });

  it("keeps a multi-line body intact, trimming only the ends", () => {
    const body = "Yesterday:\n\nToday:\n  - indented\n\nBlockers:";
    const keyword = keywordsService.createKeyword({ name: "standup", body: `\n${body}\n` });
    expect(keyword.body).toBe(body);
    expect(keywordsService.getKeyword("standup")!.body).toBe(body);
  });

  it("rejects duplicate names", () => {
    keywordsService.createKeyword({ name: "dup", body: "c" });
    expect(() => keywordsService.createKeyword({ name: "dup", body: "c" })).toThrow(/already exists/);
    // …including via the slug, not just the literal string.
    expect(() => keywordsService.createKeyword({ name: "  DUP  ", body: "c" })).toThrow(/already exists/);
  });

  it("updates fields partially and leaves the rest alone", () => {
    const created = keywordsService.createKeyword({ name: "kw", description: "before", body: "body" });

    const updated = keywordsService.updateKeyword("kw", { description: "after" });
    expect(updated.description).toBe("after");
    expect(updated.body).toBe("body");
    // createdAt survives an update; updatedAt is the thing that moves.
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("supports renames", () => {
    keywordsService.createKeyword({ name: "old-name", body: "body" });
    const renamed = keywordsService.updateKeyword("old-name", { name: "New Name" });
    expect(renamed.name).toBe("new-name");
    expect(keywordsService.getKeyword("old-name")).toBeNull();
    expect(keywordsService.getKeyword("new-name")!.body).toBe("body");
  });

  it("refuses a rename onto an existing keyword, leaving both intact", () => {
    keywordsService.createKeyword({ name: "one", body: "first" });
    keywordsService.createKeyword({ name: "two", body: "second" });

    expect(() => keywordsService.updateKeyword("one", { name: "two" })).toThrow(/already exists/);
    expect(keywordsService.getKeyword("one")!.body).toBe("first");
    expect(keywordsService.getKeyword("two")!.body).toBe("second");
  });

  it("renaming to the same name is not a collision with itself", () => {
    keywordsService.createKeyword({ name: "same", body: "body" });
    expect(keywordsService.updateKeyword("same", { name: "same", body: "new body" }).body).toBe("new body");
  });

  it("reports missing keywords on update and delete", () => {
    expect(() => keywordsService.updateKeyword("ghost", { body: "x" })).toThrow(/not found/);
    expect(() => keywordsService.deleteKeyword("ghost")).toThrow(/not found/);
  });

  it("deletes keywords", () => {
    keywordsService.createKeyword({ name: "gone", body: "c" });
    keywordsService.createKeyword({ name: "stays", body: "c" });
    keywordsService.deleteKeyword("gone");
    expect(keywordsService.getKeyword("gone")).toBeNull();
    expect(keywordsService.listKeywords().map((k) => k.name)).toEqual(["stays"]);
  });

  it("lists keywords sorted by name", () => {
    keywordsService.createKeyword({ name: "ccc", body: "c" });
    keywordsService.createKeyword({ name: "aaa", body: "c" });
    keywordsService.createKeyword({ name: "bbb", body: "c" });
    expect(keywordsService.listKeywords().map((k) => k.name)).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("rejects names that are not valid slugs on lookup rather than reading the disk", () => {
    keywordsService.createKeyword({ name: "real", body: "c" });
    expect(keywordsService.getKeyword("../../etc/passwd")).toBeNull();
    expect(keywordsService.getKeyword("Real")).toBeNull();
  });
});

describe("size caps", () => {
  it("requires a non-empty body", () => {
    expect(() => keywordsService.createKeyword({ name: "k", body: "" })).toThrow(/body is required/);
    expect(() => keywordsService.createKeyword({ name: "k", body: "   \n  " })).toThrow(/body is required/);
  });

  it("caps the body", () => {
    expect(() => keywordsService.createKeyword({ name: "k", body: "x".repeat(32 * 1024 + 1) })).toThrow(/32768 characters or fewer/);
    // The boundary itself is allowed.
    expect(keywordsService.createKeyword({ name: "k", body: "x".repeat(32 * 1024) }).body).toHaveLength(32 * 1024);
  });

  it("caps the description", () => {
    expect(() => keywordsService.createKeyword({ name: "k", description: "d".repeat(513), body: "c" })).toThrow(/512 characters or fewer/);
  });

  it("caps the name length by truncating the slug", () => {
    const keyword = keywordsService.createKeyword({ name: "a".repeat(200), body: "c" });
    expect(keyword.name).toHaveLength(64);
  });

  it("caps the total number of keywords", () => {
    const keywords = Array.from({ length: 500 }, (_, i) => ({
      name: `k${i}`,
      description: "",
      body: "c",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    writeFileSync(KEYWORDS_FILE, JSON.stringify({ version: 1, keywords }), "utf8");

    expect(() => keywordsService.createKeyword({ name: "one-too-many", body: "c" })).toThrow(/limit reached/);
    // Updating an existing one is still fine at the cap.
    expect(keywordsService.updateKeyword("k0", { body: "changed" }).body).toBe("changed");
  });
});

describe("missing and corrupt file recovery", () => {
  it("treats a missing file as empty", () => {
    expect(existsSync(KEYWORDS_FILE)).toBe(false);
    expect(keywordsService.listKeywords()).toEqual([]);
    expect(keywordsService.getKeyword("anything")).toBeNull();
  });

  it("treats unparseable JSON as empty rather than throwing", () => {
    writeFileSync(KEYWORDS_FILE, "{ this is not json,,, ", "utf8");
    expect(keywordsService.listKeywords()).toEqual([]);
    expect(keywordsService.getKeyword("anything")).toBeNull();
  });

  it("treats JSON of the wrong shape as empty", () => {
    for (const bad of ["null", "[]", '"a string"', "{}", '{"keywords": "not an array"}']) {
      writeFileSync(KEYWORDS_FILE, bad, "utf8");
      expect(keywordsService.listKeywords()).toEqual([]);
    }
  });

  it("drops malformed entries but keeps the good ones", () => {
    writeFileSync(
      KEYWORDS_FILE,
      JSON.stringify({
        version: 1,
        keywords: [
          { name: "good", description: "d", body: "b", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
          null,
          "not an object",
          { name: "no-body" },
          { name: "Bad Slug", body: "b" },
          { body: "nameless" },
          // A duplicate of an earlier name — first one wins.
          { name: "good", body: "shadow" },
          // Missing timestamps are filled in rather than disqualifying.
          { name: "timeless", body: "b" },
        ],
      }),
      "utf8",
    );

    const list = keywordsService.listKeywords();
    expect(list.map((k) => k.name)).toEqual(["good", "timeless"]);
    expect(list.find((k) => k.name === "good")!.body).toBe("b");
    expect(list.find((k) => k.name === "timeless")!.description).toBe("");
    expect(() => new Date(list[1].createdAt).toISOString()).not.toThrow();
  });

  it("leaves no temp file behind after a write", () => {
    keywordsService.createKeyword({ name: "atomic", body: "c" });
    expect(strays()).toEqual([]);
  });
});

/**
 * Reading a file we did not fully understand is survivable. *Writing over* one
 * is not, and the two are one keystroke apart: degrading a corrupt store to `[]`
 * on read is documented behaviour, and the very next `createKeyword` used to
 * persist that empty list straight over the top — no error, no copy, every
 * keyword gone. The file is meant to be hand-edited, so a stray comma is an
 * expected state rather than an exotic one.
 *
 * The rule these pin is deliberately broader than "unparseable": a write never
 * overwrites a file whose contents were not fully represented in the read it is
 * based on, whatever the reason.
 */
describe("a write never destroys a file it could not fully parse", () => {
  it("copies an unparseable file aside before replacing it", () => {
    writeFileSync(KEYWORDS_FILE, '{ "version": 1, "keywords": [{"name": "precious",,, ', "utf8");
    keywordsService.createKeyword({ name: "fresh", body: "c" });

    // The new store is written and usable…
    const raw = JSON.parse(readFileSync(KEYWORDS_FILE, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.keywords.map((k: { name: string }) => k.name)).toEqual(["fresh"]);

    // …and the bytes it replaced still exist, verbatim, one `mv` from recovery.
    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(tmpRoot, backups()[0]), "utf8")).toBe('{ "version": 1, "keywords": [{"name": "precious",,, ');
  });

  it("copies aside a file that parses but is not a store", () => {
    writeFileSync(KEYWORDS_FILE, '{"keywords": "not an array"}', "utf8");
    keywordsService.createKeyword({ name: "fresh", body: "c" });
    expect(backups()).toHaveLength(1);
  });

  it("copies aside when entries were dropped, not only when nothing parsed", () => {
    // The good entry survives into the new store, but the malformed ones are
    // about to be written out of existence — so the original is kept.
    writeFileSync(
      KEYWORDS_FILE,
      JSON.stringify({
        version: 1,
        keywords: [{ name: "good", body: "b" }, { name: "Bad Slug", body: "b" }, { body: "nameless" }],
      }),
      "utf8",
    );
    keywordsService.createKeyword({ name: "fresh", body: "c" });

    expect(keywordsService.listKeywords().map((k) => k.name)).toEqual(["fresh", "good"]);
    expect(backups()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(tmpRoot, backups()[0]), "utf8")).keywords).toHaveLength(3);
  });

  it("copies aside when a duplicate name was shadowed", () => {
    writeFileSync(
      KEYWORDS_FILE,
      JSON.stringify({ version: 1, keywords: [{ name: "dup", body: "first" }, { name: "dup", body: "second" }] }),
      "utf8",
    );
    keywordsService.deleteKeyword("dup");
    expect(backups()).toHaveLength(1);
  });

  it("keeps a copy on update and delete too, not only on create", () => {
    for (const mutate of [
      () => keywordsService.updateKeyword("good", { body: "changed" }),
      () => keywordsService.deleteKeyword("good"),
    ]) {
      writeFileSync(KEYWORDS_FILE, JSON.stringify({ version: 1, keywords: [{ name: "good", body: "b" }, null] }), "utf8");
      mutate();
      expect(backups()).toHaveLength(1);
      for (const file of readdirSync(tmpRoot)) rmSync(join(tmpRoot, file), { force: true });
    }
  });

  it("does not litter backups when the file was understood completely", () => {
    keywordsService.createKeyword({ name: "one", body: "c" });
    keywordsService.createKeyword({ name: "two", body: "c" });
    keywordsService.updateKeyword("one", { body: "changed" });
    keywordsService.deleteKeyword("two");
    expect(strays()).toEqual([]);
  });

  it("does not treat a blank file as something to preserve", () => {
    writeFileSync(KEYWORDS_FILE, "  \n ", "utf8");
    keywordsService.createKeyword({ name: "fresh", body: "c" });
    expect(strays()).toEqual([]);
  });

  it("keeps every copy when the same file is written over twice", () => {
    writeFileSync(KEYWORDS_FILE, "not json at all", "utf8");
    keywordsService.createKeyword({ name: "one", body: "c" });
    writeFileSync(KEYWORDS_FILE, "still not json", "utf8");
    keywordsService.createKeyword({ name: "two", body: "c" });

    // Timestamps collide at millisecond resolution; a collision must not make
    // the second backup silently overwrite the first.
    expect(backups()).toHaveLength(2);
    const contents = backups().map((f) => readFileSync(join(tmpRoot, f), "utf8")).sort();
    expect(contents).toEqual(["not json at all", "still not json"]);
  });

  /**
   * "Understood the whole file" has to mean the whole file, not just the parts
   * this version happens to look at. A store is a plain JSON document the user
   * is invited to hand-edit, and the population that hand-edits a config file
   * is exactly the population that annotates it — and a future format is the
   * same problem arriving from the other direction, since a downgrade would
   * otherwise rewrite a v2 store as v1 and drop every v2 field on the floor.
   *
   * Neither costs anything today. Both are silent, unrecoverable, and against
   * the rule the rest of this file exists to enforce.
   */
  describe("fields this version does not know about", () => {
    it("preserves a store carrying an unrecognized version", () => {
      writeFileSync(KEYWORDS_FILE, JSON.stringify({ version: 2, keywords: [{ name: "kw", body: "b" }] }), "utf8");
      keywordsService.createKeyword({ name: "fresh", body: "c" });
      expect(backups()).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(tmpRoot, backups()[0]), "utf8")).version).toBe(2);
    });

    it("preserves unknown top-level keys", () => {
      writeFileSync(
        KEYWORDS_FILE,
        JSON.stringify({ version: 1, comment: "hand-written notes I care about", keywords: [{ name: "kw", body: "b" }] }),
        "utf8",
      );
      keywordsService.createKeyword({ name: "fresh", body: "c" });
      expect(backups()).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(tmpRoot, backups()[0]), "utf8")).comment).toBe("hand-written notes I care about");
    });

    it("preserves unknown per-keyword keys", () => {
      writeFileSync(
        KEYWORDS_FILE,
        JSON.stringify({ version: 1, keywords: [{ name: "kw", body: "b", tags: ["a"], pinned: true }] }),
        "utf8",
      );
      keywordsService.createKeyword({ name: "fresh", body: "c" });
      expect(backups()).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(tmpRoot, backups()[0]), "utf8")).keywords[0].tags).toEqual(["a"]);
    });

    it("still reads such a store normally — preserving is not refusing", () => {
      writeFileSync(
        KEYWORDS_FILE,
        JSON.stringify({ version: 2, note: "x", keywords: [{ name: "kw", body: "b", tags: ["a"] }] }),
        "utf8",
      );
      expect(keywordsService.listKeywords().map((k) => k.name)).toEqual(["kw"]);
    });

    it("treats a missing version as nothing to lose", () => {
      // An absent key is not data; a hand-written file without one is fine.
      writeFileSync(KEYWORDS_FILE, JSON.stringify({ keywords: [{ name: "kw", body: "b" }] }), "utf8");
      keywordsService.createKeyword({ name: "fresh", body: "c" });
      expect(strays()).toEqual([]);
    });

    it("accepts every field this version does write, without a backup", () => {
      // The guard must not fire on the service's own output.
      keywordsService.createKeyword({ name: "kw", description: "d", body: "b" });
      keywordsService.createKeyword({ name: "kw2", body: "b" });
      expect(strays()).toEqual([]);
    });
  });

  /**
   * When the copy itself cannot be made, the write is refused — bytes that
   * cannot be preserved must not be overwritten. What the user then sees has to
   * name the real problem: their *store* is broken and unbackupable, their
   * input was fine, and nothing was lost. "500 Failed to create keyword" says
   * none of that and points at the wrong thing.
   */
  describe("when the store cannot even be copied aside", () => {
    // Root bypasses the permission bits this leans on, so the setup would
    // silently succeed and the test would pass for the wrong reason.
    const asRoot = process.getuid?.() === 0;

    it.skipIf(asRoot)("refuses the write and explains why, in a sentence a user can act on", () => {
      writeFileSync(KEYWORDS_FILE, '{"keywords": [{"name": "precious", "body": "b"}],,,', "utf8");
      chmodSync(KEYWORDS_FILE, 0o000); // unreadable: neither parseable nor copyable

      try {
        let caught: unknown;
        try {
          keywordsService.createKeyword({ name: "fresh", body: "c" });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(KeywordStoreUnwritableError);
        const { message } = caught as Error;
        expect(message).toMatch(/could not be read as valid JSON/);
        expect(message).toMatch(/backup copy of it could not be written/);
        expect(message).toMatch(/[Nn]othing was changed and nothing was lost/);
        // Names the file to fix, so the remedy does not require guessing.
        expect(message).toContain(KEYWORDS_FILE);
        // …and carries the underlying cause rather than hiding it.
        expect(message).toMatch(/EACCES|EPERM/);
      } finally {
        chmodSync(KEYWORDS_FILE, 0o600);
      }

      // The refusal is the point: the original bytes are still there.
      expect(readFileSync(KEYWORDS_FILE, "utf8")).toBe('{"keywords": [{"name": "precious", "body": "b"}],,,');
    });
  });

  /**
   * A store reached through a symlink — into a dotfiles repo, a synced folder —
   * must stay a symlink. The write ends in a rename, which would otherwise
   * replace the link with a regular file and leave the real target frozen with
   * whatever it held when the link was made.
   */
  describe("a symlinked store", () => {
    it("writes through the link instead of replacing it", () => {
      const real = join(tmpRoot, "real-store.json");
      writeFileSync(real, JSON.stringify({ version: 1, keywords: [{ name: "existing", body: "b" }] }), "utf8");
      symlinkSync(real, KEYWORDS_FILE);

      keywordsService.createKeyword({ name: "added", body: "c" });

      // Still a link…
      expect(lstatSync(KEYWORDS_FILE).isSymbolicLink()).toBe(true);
      // …and the real file behind it is the one that changed.
      const written = JSON.parse(readFileSync(real, "utf8"));
      expect(written.keywords.map((k: { name: string }) => k.name)).toEqual(["added", "existing"]);
      expect(keywordsService.listKeywords().map((k) => k.name)).toEqual(["added", "existing"]);
    });

    it("puts a quarantine copy beside the real file, not beside the link", () => {
      const real = join(tmpRoot, "real-store.json");
      writeFileSync(real, "not json at all", "utf8");
      symlinkSync(real, KEYWORDS_FILE);

      keywordsService.createKeyword({ name: "fresh", body: "c" });

      expect(lstatSync(KEYWORDS_FILE).isSymbolicLink()).toBe(true);
      const copies = readdirSync(tmpRoot).filter((f) => f.startsWith("real-store.json.corrupt-"));
      expect(copies).toHaveLength(1);
      expect(readFileSync(join(tmpRoot, copies[0]), "utf8")).toBe("not json at all");
    });
  });
});
