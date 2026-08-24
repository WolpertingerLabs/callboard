import { describe, it, expect, vi, afterAll, afterEach, beforeEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
// The `fs` mock below replaces `statSync` with a spy; the memoisation suite
// asserts on its call count, so it needs the mocked binding, not `node:fs`.
import { statSync as mockedStatSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProjectDirFolderCache, isIgnoredProjectFolder, projectDirToFolder, saveIgnoredProjectDirPrefixes } from "./paths.js";

/**
 * Tests for projectDirToFolder — decoding Claude SDK encoded project directory
 * names back to real filesystem paths.
 *
 * The SDK encodes paths via: path.replace(/[^a-zA-Z0-9]/g, "-")
 * So "/home/user/my.app" becomes "-home-user-my-app".
 *
 * The decoder uses a greedy algorithm + recovery strategies. These tests mock
 * the filesystem to control which directories/files "exist" and verify correct
 * resolution under various ambiguity scenarios.
 */

// ── Filesystem mocking ────────────────────────────────────────────────

// Sets of paths that exist as directories or files (for statSync/readdirSync mocks)
let mockDirectories: Set<string>;
let mockFiles: Set<string>;
// Map of directory path → list of entries (for readdirSync mock)
let mockDirEntries: Map<string, string[]>;

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    statSync: vi.fn((p: string) => {
      if (mockDirectories.has(p)) {
        return { isDirectory: () => true };
      }
      if (mockFiles.has(p)) {
        return { isDirectory: () => false };
      }
      throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
    }),
    readdirSync: vi.fn((p: string) => {
      const entries = mockDirEntries.get(p);
      if (entries) return entries;
      throw new Error(`ENOENT: no such file or directory, scandir '${p}'`);
    }),
  };
});

function setupFS(opts: {
  dirs?: string[];
  files?: string[];
  listings?: Record<string, string[]>;
}) {
  mockDirectories = new Set(opts.dirs ?? []);
  mockFiles = new Set(opts.files ?? []);
  mockDirEntries = new Map(Object.entries(opts.listings ?? {}));
  // `projectDirToFolder` memoises its answer per project-dir name, and these
  // cases deliberately re-ask the same name against a different filesystem —
  // `-repo-feature` resolves one way when `/repo/feature` exists and another
  // when only `/repo.feature` does. Redefining the filesystem is exactly the
  // event that voids a cached decode, so it is voided here rather than in a
  // `beforeEach` that could drift away from the setup it belongs to.
  clearProjectDirFolderCache();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDirectories = new Set();
  mockFiles = new Set();
  mockDirEntries = new Map();
  clearProjectDirFolderCache();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("projectDirToFolder", () => {
  describe("basic greedy resolution (no ambiguity)", () => {
    it("resolves a simple two-segment path", () => {
      setupFS({
        dirs: ["/home", "/home/user"],
        files: ["/home/user/project"],
        listings: {},
      });
      expect(projectDirToFolder("-home-user-project")).toBe(
        "/home/user/project",
      );
    });

    it("resolves a deeper path with all intermediate directories", () => {
      setupFS({
        dirs: [
          "/Users",
          "/Users/me",
          "/Users/me/Documents",
          "/Users/me/Documents/Projects",
        ],
        files: ["/Users/me/Documents/Projects/my-app"],
        listings: {},
      });
      expect(
        projectDirToFolder("-Users-me-Documents-Projects-my-app"),
      ).toBe("/Users/me/Documents/Projects/my-app");
    });

    it("preserves literal dashes in the last segment when no intermediate dir matches", () => {
      setupFS({
        dirs: ["/home", "/home/user"],
        files: ["/home/user/my-cool-app"],
        listings: {},
      });
      expect(projectDirToFolder("-home-user-my-cool-app")).toBe(
        "/home/user/my-cool-app",
      );
    });

    it("handles root-level path", () => {
      setupFS({ dirs: [], files: ["/tmp"], listings: {} });
      expect(projectDirToFolder("-tmp")).toBe("/tmp");
    });

    it("handles single empty split (root /)", () => {
      expect(projectDirToFolder("-")).toBe("/");
    });
  });

  describe("period-to-dash recovery via filesystem scan", () => {
    it("resolves a folder with a period in the name (e.g. worktree)", () => {
      setupFS({
        dirs: [
          "/Users",
          "/Users/me",
          "/Users/me/Projects",
          // "callboard" exists — greedy will split here incorrectly
          "/Users/me/Projects/callboard",
          // The REAL target with a period
          "/Users/me/Projects/callboard.feat-new-feature",
        ],
        listings: {
          "/Users/me/Projects": [
            "callboard",
            "callboard.feat-new-feature",
            "other-repo",
          ],
        },
      });

      // Encoded: callboard.feat-new-feature → callboard-feat-new-feature
      expect(
        projectDirToFolder(
          "-Users-me-Projects-callboard-feat-new-feature",
        ),
      ).toBe("/Users/me/Projects/callboard.feat-new-feature");
    });

    it("resolves multiple period-separated segments", () => {
      setupFS({
        dirs: [
          "/Users",
          "/Users/me",
          "/Users/me/repos",
          "/Users/me/repos/app",
          "/Users/me/repos/app.v2.beta",
        ],
        listings: {
          "/Users/me/repos": ["app", "app.v2.beta", "other"],
        },
      });

      expect(
        projectDirToFolder("-Users-me-repos-app-v2-beta"),
      ).toBe("/Users/me/repos/app.v2.beta");
    });

    it("resolves a period folder when parent has many entries", () => {
      setupFS({
        dirs: [
          "/home",
          "/home/dev",
          "/home/dev/code",
          "/home/dev/code/repo",
          "/home/dev/code/repo.fix-bug-123",
        ],
        listings: {
          "/home/dev/code": [
            "repo",
            "repo.fix-bug-123",
            "repo.feat-other",
            "unrelated",
          ],
        },
      });

      expect(
        projectDirToFolder("-home-dev-code-repo-fix-bug-123"),
      ).toBe("/home/dev/code/repo.fix-bug-123");
    });
  });

  describe("literal-dash recovery via filesystem scan", () => {
    it("resolves a folder with literal dashes when an intermediate dir exists", () => {
      setupFS({
        dirs: [
          "/Users",
          "/Users/me",
          "/Users/me/Projects",
          // "callboard" exists — greedy splits here
          "/Users/me/Projects/callboard",
          // The REAL target has literal dashes
          "/Users/me/Projects/callboard-drawlatch-e2e",
        ],
        listings: {
          "/Users/me/Projects": [
            "callboard",
            "callboard-drawlatch-e2e",
            "other-repo",
          ],
        },
      });

      expect(
        projectDirToFolder(
          "-Users-me-Projects-callboard-drawlatch-e2e",
        ),
      ).toBe("/Users/me/Projects/callboard-drawlatch-e2e");
    });

    it("resolves when the wrong split produces a non-existent sub-path", () => {
      setupFS({
        dirs: [
          "/home",
          "/home/user",
          // "my" exists as a directory (false positive for greedy)
          "/home/user/my",
          // Real target
          "/home/user/my-cool-project",
        ],
        listings: {
          "/home/user": ["my", "my-cool-project", "documents"],
        },
      });

      expect(
        projectDirToFolder("-home-user-my-cool-project"),
      ).toBe("/home/user/my-cool-project");
    });
  });

  describe("underscore and space recovery via filesystem scan", () => {
    it("resolves a folder with underscores (encoded as dashes)", () => {
      setupFS({
        dirs: [
          "/home",
          "/home/user",
          "/home/user/my_project",
        ],
        listings: {
          "/home/user": ["my_project", "documents"],
        },
      });

      // "my_project" encodes to "my-project"
      expect(projectDirToFolder("-home-user-my-project")).toBe(
        "/home/user/my_project",
      );
    });

    it("resolves a folder with spaces (encoded as dashes)", () => {
      setupFS({
        dirs: [
          "/Users",
          "/Users/me",
          "/Users/me/My Projects",
        ],
        listings: {
          "/Users/me": ["My Projects", "Documents"],
        },
      });

      // "My Projects" encodes to "My-Projects"
      expect(projectDirToFolder("-Users-me-My-Projects")).toBe(
        "/Users/me/My Projects",
      );
    });

    /**
     * The two cases above put the special character in the *leaf*, which is the
     * only place a single-entry scan can find one. Everything below it is the
     * same character one level up, where the greedy pass stalls and swallows
     * every remaining segment — so recovery has to descend, not just match.
     */
    it("resolves an underscore in an intermediate directory, not just the leaf", () => {
      setupFS({
        dirs: ["/home", "/home/user", "/home/user/my_repos", "/home/user/my_repos/callboard"],
        listings: {
          "/home/user": ["my_repos", "documents"],
          "/home/user/my_repos": ["callboard", "other"],
        },
      });

      // Greedy: /home ✓, /home/user ✓, then "/home/user/my" is not a directory
      // and neither is "/home/user/my.repos", so "my-repos-callboard" becomes
      // one segment. No entry of /home/user encodes to all of it.
      expect(projectDirToFolder("-home-user-my-repos-callboard")).toBe("/home/user/my_repos/callboard");
    });

    it("descends through several unguessable levels at once", () => {
      // macOS $TMPDIR, which is why the test suite itself found this: a random
      // per-boot directory with underscores, four levels above the target.
      setupFS({
        dirs: [
          "/var",
          "/var/folders",
          "/var/folders/t2",
          "/var/folders/t2/zwj_rw5x1yg07r7_p0mqgrf40000gn",
          "/var/folders/t2/zwj_rw5x1yg07r7_p0mqgrf40000gn/T",
          "/var/folders/t2/zwj_rw5x1yg07r7_p0mqgrf40000gn/T/callboard-abc",
          "/var/folders/t2/zwj_rw5x1yg07r7_p0mqgrf40000gn/T/callboard-abc/main-kept",
        ],
        listings: {
          "/var/folders/t2": ["zwj_rw5x1yg07r7_p0mqgrf40000gn"],
          "/var/folders/t2/zwj_rw5x1yg07r7_p0mqgrf40000gn": ["T", "C"],
          "/var/folders/t2/zwj_rw5x1yg07r7_p0mqgrf40000gn/T": ["callboard-abc"],
          "/var/folders/t2/zwj_rw5x1yg07r7_p0mqgrf40000gn/T/callboard-abc": ["main", "main-kept"],
        },
      });

      expect(projectDirToFolder("-var-folders-t2-zwj-rw5x1yg07r7-p0mqgrf40000gn-T-callboard-abc-main-kept")).toBe(
        "/var/folders/t2/zwj_rw5x1yg07r7_p0mqgrf40000gn/T/callboard-abc/main-kept",
      );
    });

    it("prefers a literal-dash directory over splitting at the same dash", () => {
      // Both readings exist. The descent tries whole-entry matches before
      // prefixes, so `a-b` wins over `a/b` — the same precedence the greedy
      // pass would have applied had it got that far.
      setupFS({
        dirs: ["/home", "/home/user", "/home/user/x_y", "/home/user/x_y/a-b", "/home/user/x_y/a", "/home/user/x_y/a/b"],
        listings: {
          "/home/user": ["x_y"],
          "/home/user/x_y": ["a", "a-b"],
        },
      });

      expect(projectDirToFolder("-home-user-x-y-a-b")).toBe("/home/user/x_y/a-b");
    });

    it("returns the best-effort path when no descent reaches a real directory", () => {
      // Non-vacuous guard on the recursion: a suffix that matches a prefix at
      // every level but dead-ends must not resolve to the partial path.
      setupFS({
        dirs: ["/home", "/home/user", "/home/user/my_repos"],
        listings: {
          "/home/user": ["my_repos"],
          "/home/user/my_repos": ["callboard"],
        },
      });

      expect(projectDirToFolder("-home-user-my-repos-nothing-here")).toBe("/home/user/my-repos-nothing-here");
    });
  });

  describe("scan recovery with multiple merge levels", () => {
    it("recovers when the greedy algorithm split at two wrong points", () => {
      setupFS({
        dirs: [
          "/a",
          "/a/b",
          // "b" exists, AND "c" inside it exists — two false splits
          "/a/b/c",
          // Real target: 3 segments need merging
          "/a/b.c.d",
        ],
        listings: {
          "/a": ["b", "b.c.d"],
        },
      });

      // "b.c.d" encodes to "b-c-d"
      // Greedy: /a ✓, /a/b ✓ (split), /a/b/c ✓ (split), final: "d"
      // Resolved: /a/b/c/d → doesn't exist → scan recovery
      // mergeCount=2: parent=/a/b, check "c-d" → no match
      // mergeCount=3: parent=/a, check "b-c-d" → "b.c.d" matches!
      expect(projectDirToFolder("-a-b-c-d")).toBe("/a/b.c.d");
    });

    it("prefers smaller merge counts (finds closest match first)", () => {
      setupFS({
        dirs: [
          "/a",
          "/a/b",
          // Both exist — scan should find mergeCount=2 first
          "/a/b.c",
          "/a/b/c", // false positive for greedy
        ],
        files: ["/a/b.c"], // b.c exists but as file only
        listings: {
          // mergeCount=2 scans /a and finds "b.c"
          "/a": ["b", "b.c"],
        },
      });

      // /a/b/c exists but the full path /a/b/c doesn't need recovery
      // We need a case where /a/b exists, /a/b/c doesn't exist
      setupFS({
        dirs: ["/a", "/a/b", "/a/b.c"],
        listings: {
          "/a": ["b", "b.c"],
        },
      });

      expect(projectDirToFolder("-a-b-c")).toBe("/a/b.c");
    });
  });

  describe("dot recovery fallback (when scan recovery fails)", () => {
    it("falls back to dot recovery when parent is not listable", () => {
      // Scan recovery can't work if readdirSync fails on the parent.
      // Dot recovery (Phase 1) replaces dashes with dots within segments.
      setupFS({
        dirs: ["/home", "/home/user"],
        files: ["/home/user/repo.name"],
        // No listings — readdirSync will throw for all dirs
      });

      expect(projectDirToFolder("-home-user-repo-name")).toBe(
        "/home/user/repo.name",
      );
    });

    it("falls back to dot recovery when scan finds no match", () => {
      setupFS({
        dirs: ["/home", "/home/user"],
        files: ["/home/user/repo.name"],
        listings: {
          // Listing exists but doesn't contain the target (e.g. stale listing)
          "/home/user": ["other-stuff"],
        },
      });

      // Scan recovery checks /home/user listing but "repo.name" isn't there
      // Dot recovery Phase 1: tries "repo.name" → exists as file → match!
      expect(projectDirToFolder("-home-user-repo-name")).toBe(
        "/home/user/repo.name",
      );
    });
  });

  describe("no recovery needed (greedy succeeds directly)", () => {
    it("returns the greedy result when the path exists", () => {
      setupFS({
        dirs: [
          "/Users",
          "/Users/me",
          "/Users/me/Documents",
          "/Users/me/Documents/callboard",
        ],
        listings: {},
      });

      expect(
        projectDirToFolder("-Users-me-Documents-callboard"),
      ).toBe("/Users/me/Documents/callboard");
    });

    it("returns greedy result for a file at the end of the path", () => {
      setupFS({
        dirs: ["/a", "/a/b"],
        files: ["/a/b/c"],
        listings: {},
      });

      expect(projectDirToFolder("-a-b-c")).toBe("/a/b/c");
    });
  });

  describe("best-effort fallback (nothing matches)", () => {
    it("returns the greedy result when no recovery succeeds", () => {
      // No directories exist at all — greedy concatenates everything
      setupFS({ dirs: [], files: [], listings: {} });

      expect(projectDirToFolder("-a-b-c-d")).toBe(
        "/a-b-c-d",
      );
    });

    it("returns wrong greedy split when folder was deleted", () => {
      // Greedy splits at /a/b because "b" exists, but the real folder
      // "b-c" was deleted so no recovery can find it.
      setupFS({
        dirs: ["/a", "/a/b"],
        listings: {
          "/a": ["b"], // "b-c" no longer on disk
        },
      });

      // Best effort: greedy gives /a/b/c, doesn't exist, recovery fails
      expect(projectDirToFolder("-a-b-c")).toBe("/a/b/c");
    });
  });

  describe("disambiguation between period, dash, and slash", () => {
    it("picks the period-folder over a non-existent slash-path", () => {
      setupFS({
        dirs: [
          "/repo",
          // "repo" exists (greedy splits), but "repo/feature" doesn't
          "/repo.feature", // period folder exists
        ],
        listings: {
          "/": ["repo", "repo.feature"],
        },
      });

      expect(projectDirToFolder("-repo-feature")).toBe(
        "/repo.feature",
      );
    });

    it("picks the dash-folder over a non-existent slash-path", () => {
      setupFS({
        dirs: [
          "/",
          "/repo",
          "/repo-feature", // dash folder exists
        ],
        listings: {
          "/": ["repo", "repo-feature"],
        },
      });

      expect(projectDirToFolder("-repo-feature")).toBe(
        "/repo-feature",
      );
    });

    it("prefers the existing greedy path when it is valid", () => {
      setupFS({
        dirs: [
          "/repo",
          "/repo/feature", // greedy path exists
          "/repo.feature", // period path also exists
        ],
        listings: {
          "/": ["repo", "repo.feature"],
        },
      });

      // Greedy produces /repo/feature, which exists → returned directly
      // (scan recovery is never invoked)
      expect(projectDirToFolder("-repo-feature")).toBe(
        "/repo/feature",
      );
    });
  });

  describe("real-world worktree patterns", () => {
    it("resolves a git worktree path: repo.branch-name", () => {
      setupFS({
        dirs: [
          "/Users",
          "/Users/dev",
          "/Users/dev/Projects",
          "/Users/dev/Projects/callboard",
          "/Users/dev/Projects/callboard.fix-period-to-dash-folder-resolver",
        ],
        listings: {
          "/Users/dev/Projects": [
            "callboard",
            "callboard.fix-period-to-dash-folder-resolver",
            "callboard.feat-new-ui",
            "other-repo",
          ],
        },
      });

      expect(
        projectDirToFolder(
          "-Users-dev-Projects-callboard-fix-period-to-dash-folder-resolver",
        ),
      ).toBe(
        "/Users/dev/Projects/callboard.fix-period-to-dash-folder-resolver",
      );
    });

    it("resolves a worktree alongside a sibling repo with dashes", () => {
      setupFS({
        dirs: [
          "/Users",
          "/Users/dev",
          "/Users/dev/Projects",
          "/Users/dev/Projects/callboard",
          "/Users/dev/Projects/callboard-e2e",
          "/Users/dev/Projects/callboard.feat-login",
        ],
        listings: {
          "/Users/dev/Projects": [
            "callboard",
            "callboard-e2e",
            "callboard.feat-login",
          ],
        },
      });

      // Each encodes differently:
      // callboard-e2e → -Users-dev-Projects-callboard-e2e
      // callboard.feat-login → -Users-dev-Projects-callboard-feat-login
      expect(
        projectDirToFolder("-Users-dev-Projects-callboard-e2e"),
      ).toBe("/Users/dev/Projects/callboard-e2e");

      expect(
        projectDirToFolder(
          "-Users-dev-Projects-callboard-feat-login",
        ),
      ).toBe("/Users/dev/Projects/callboard.feat-login");
    });
  });

  describe("encoding round-trip consistency", () => {
    /**
     * Helper: encode a path the same way Claude SDK does
     */
    function encode(path: string): string {
      return path.replace(/[^a-zA-Z0-9]/g, "-");
    }

    it("round-trips a simple path", () => {
      const original = "/home/user/project";
      setupFS({
        dirs: ["/home", "/home/user"],
        files: ["/home/user/project"],
      });

      expect(projectDirToFolder(encode(original))).toBe(original);
    });

    it("round-trips a path with periods via scan recovery", () => {
      const original = "/Users/dev/repo.feat-branch";
      setupFS({
        dirs: [
          "/Users",
          "/Users/dev",
          "/Users/dev/repo",
          "/Users/dev/repo.feat-branch",
        ],
        listings: {
          "/Users/dev": ["repo", "repo.feat-branch"],
        },
      });

      expect(projectDirToFolder(encode(original))).toBe(original);
    });

    it("round-trips a path with underscores via scan recovery", () => {
      const original = "/home/user/my_project";
      setupFS({
        dirs: ["/home", "/home/user", "/home/user/my_project"],
        listings: {
          "/home/user": ["my_project"],
        },
      });

      expect(projectDirToFolder(encode(original))).toBe(original);
    });

    it("round-trips a path with a hidden directory", () => {
      const original = "/Users/me/.callboard/workspaces/hex";
      setupFS({
        dirs: [
          "/Users",
          "/Users/me",
          "/Users/me/.callboard",
          "/Users/me/.callboard/workspaces",
        ],
        files: ["/Users/me/.callboard/workspaces/hex"],
      });

      // /Users/me/.callboard → -Users-me--callboard (double-dash from /.)
      expect(projectDirToFolder(encode(original))).toBe(original);
    });
  });

  describe("hidden dot-directory pre-processing (double-dash handling)", () => {
    it("resolves a path with a hidden directory in home", () => {
      // ~/.callboard/agent-workspaces/hex
      // Encoded: -Users-me--callboard-agent-workspaces-hex
      // The double-dash "--" represents "/." (path separator + dot prefix)
      setupFS({
        dirs: [
          "/Users",
          "/Users/me",
          "/Users/me/.callboard",
          "/Users/me/.callboard/agent-workspaces",
        ],
        files: ["/Users/me/.callboard/agent-workspaces/hex"],
      });

      expect(
        projectDirToFolder(
          "-Users-me--callboard-agent-workspaces-hex",
        ),
      ).toBe("/Users/me/.callboard/agent-workspaces/hex");
    });

    it("resolves a .worktrees hidden directory inside a project", () => {
      setupFS({
        dirs: [
          "/Users",
          "/Users/me",
          "/Users/me/Projects",
          "/Users/me/Projects/my-app",
          "/Users/me/Projects/my-app/.worktrees",
        ],
        files: ["/Users/me/Projects/my-app/.worktrees/branch-42"],
      });

      expect(
        projectDirToFolder(
          "-Users-me-Projects-my-app--worktrees-branch-42",
        ),
      ).toBe("/Users/me/Projects/my-app/.worktrees/branch-42");
    });

    it("resolves a deeply nested hidden directory", () => {
      setupFS({
        dirs: [
          "/Users",
          "/Users/me",
          "/Users/me/.config",
          "/Users/me/.config/.secrets",
        ],
        files: ["/Users/me/.config/.secrets/keys"],
      });

      // /Users/me/.config/.secrets/keys → -Users-me--config--secrets-keys
      expect(
        projectDirToFolder("-Users-me--config--secrets-keys"),
      ).toBe("/Users/me/.config/.secrets/keys");
    });

    it("handles double-dot from consecutive non-alphanumeric chars", () => {
      // Rare case: "---" in the encoded string represents ".." or similar
      setupFS({
        dirs: ["/a", "/a/..hidden"],
        files: ["/a/..hidden/x"],
      });

      // /a/..hidden/x → -a---hidden-x (three dashes: / + . + .)
      expect(projectDirToFolder("-a---hidden-x")).toBe(
        "/a/..hidden/x",
      );
    });
  });

  describe("inline dot-check in greedy pass (intermediate dot-directories)", () => {
    it("resolves a period in an intermediate directory name", () => {
      // /path/v2.0/src — the dot is in a MIDDLE segment, not the last
      setupFS({
        dirs: [
          "/path",
          "/path/v2.0",
          "/path/v2.0/src",
        ],
      });

      // "v2.0" encodes to "v2-0". Greedy checks: is /path/v2 a dir? No.
      // Inline dot-check: is /path/v2.0 a dir? Yes → use "v2.0" as segment.
      expect(projectDirToFolder("-path-v2-0-src")).toBe(
        "/path/v2.0/src",
      );
    });

    it("resolves nested intermediate dot-directories", () => {
      setupFS({
        dirs: [
          "/a",
          "/a/b.c",
          "/a/b.c/d.e",
        ],
        files: ["/a/b.c/d.e/f"],
      });

      expect(projectDirToFolder("-a-b-c-d-e-f")).toBe(
        "/a/b.c/d.e/f",
      );
    });

    it("prefers slash-split over dot when both paths exist as directories", () => {
      setupFS({
        dirs: [
          "/a",
          "/a/b",     // slash path exists as dir
          "/a/b.c",   // dot path also exists
        ],
        files: ["/a/b/c"],
      });

      // Greedy checks /a/b → is a dir → commits the slash split
      // Result: /a/b/c which exists → returned directly
      expect(projectDirToFolder("-a-b-c")).toBe("/a/b/c");
    });
  });
});

describe("isIgnoredProjectFolder", () => {
  // Every scratch dir this suite has ever made, in creation order. `afterEach`
  // removes each one as its test ends; `afterAll` asserts the list is gone from
  // disk. Only these exact paths are ever removed — other suites (and other
  // developers) have directories in the same temp dir at the same time.
  const scratchDirs: string[] = [];
  let originalDataDir: string | undefined;

  beforeEach(() => {
    // Point the prefix-config at a throwaway dir so we never touch the real
    // ~/.callboard config, then prime the in-memory cache with known prefixes.
    originalDataDir = process.env.CALLBOARD_DATA_DIR;
    const scratch = mkdtempSync(join(tmpdir(), "cb-paths-test-"));
    scratchDirs.push(scratch);
    process.env.CALLBOARD_DATA_DIR = scratch;
    saveIgnoredProjectDirPrefixes(["-tmp", "-private-"]);
  });

  // Runs whether the test passed or threw — a cleanup on the success path only
  // moves the leak to the failure path, which is where the runs pile up.
  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CALLBOARD_DATA_DIR;
    else process.env.CALLBOARD_DATA_DIR = originalDataDir;
    rmSync(scratchDirs[scratchDirs.length - 1], { recursive: true, force: true });
  });

  // The cleanup is only as good as the thing that checks it. This suite leaked
  // three empty dirs per run for as long as nobody looked; a future edit that
  // reintroduces that fails here instead of passing quietly.
  afterAll(() => {
    expect(scratchDirs.length).toBeGreaterThan(0);
    expect(scratchDirs.filter((dir) => existsSync(dir))).toEqual([]);
  });

  it("slugifies a raw folder path before matching ignore prefixes", () => {
    expect(isIgnoredProjectFolder("/tmp/foo")).toBe(true); // → "-tmp-foo"
    expect(isIgnoredProjectFolder("/private/var/folders/t2/x/T")).toBe(true); // → "-private-..."
  });

  it("does not ignore unrelated folders", () => {
    expect(isIgnoredProjectFolder("/Users/me/repo")).toBe(false); // → "-Users-me-repo"
  });

  it("returns false for empty input", () => {
    expect(isIgnoredProjectFolder("")).toBe(false);
  });
});

/**
 * The memo, which is the reason `GET /api/chats/folders` is affordable.
 *
 * The decoder probes the filesystem — a `statSync` per candidate split, a
 * `readdirSync` scan, and for a name that resolves to nothing a combinatorial
 * dash/dot search. Session discovery asks it **once per transcript file**, and
 * on a real machine that was 1518 calls across 83 distinct names: an 18x
 * redundancy factor, and 79 ms of blocked event loop per listing request.
 *
 * These assert on syscall counts rather than on wall-clock, because the claim
 * is "it does not ask the filesystem twice", not "it is fast today".
 */
describe("projectDirToFolder memoisation", () => {
  it("probes the filesystem once for repeated asks about the same name", () => {
    setupFS({ dirs: ["/a", "/a/b"], files: [], listings: {} });
    const statSync = vi.mocked(mockedStatSync);

    expect(projectDirToFolder("-a-b-c")).toBe("/a/b/c");
    const afterFirst = statSync.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    for (let i = 0; i < 20; i++) expect(projectDirToFolder("-a-b-c")).toBe("/a/b/c");
    expect(statSync.mock.calls.length).toBe(afterFirst);
  });

  it("still probes for a name it has not seen", () => {
    setupFS({ dirs: ["/a", "/a/b", "/x", "/x/y"], files: [], listings: {} });
    const statSync = vi.mocked(mockedStatSync);

    projectDirToFolder("-a-b-c");
    const afterFirst = statSync.mock.calls.length;

    // A different name is a different key — the memo must not answer for it.
    expect(projectDirToFolder("-x-y-z")).toBe("/x/y/z");
    expect(statSync.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("is the expensive unresolvable case that benefits most", () => {
    // Nothing exists, so the greedy pass fails and both recovery strategies
    // run to exhaustion before returning a best-effort answer. This is the
    // shape of a deleted worktree's project dir — 50 of 83 on the profiled
    // machine — and it used to pay in full on every request, forever.
    setupFS({ dirs: [], files: [], listings: {} });
    const statSync = vi.mocked(mockedStatSync);

    expect(projectDirToFolder("-a-b-c-d-e")).toBe("/a-b-c-d-e");
    const afterFirst = statSync.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(5);

    expect(projectDirToFolder("-a-b-c-d-e")).toBe("/a-b-c-d-e");
    expect(statSync.mock.calls.length).toBe(afterFirst);
  });

  it("re-probes after the cache is cleared", () => {
    setupFS({ dirs: ["/repo", "/repo/feature"], listings: { "/": ["repo"] } });
    expect(projectDirToFolder("-repo-feature")).toBe("/repo/feature");

    // The directory moved: /repo/feature is gone, /repo.feature is there.
    // A cleared memo must observe the new filesystem, not the old answer.
    setupFS({ dirs: ["/repo", "/repo.feature"], listings: { "/": ["repo", "repo.feature"] } });
    expect(projectDirToFolder("-repo-feature")).toBe("/repo.feature");
  });
});

/**
 * Entries are minted together — one listing decodes every project-dir name in
 * one synchronous pass — so a fixed TTL expires them all in the same
 * millisecond, and whichever 15-second poll lands past the boundary re-decodes
 * the lot. Measured at 49.8 ms of blocked event loop, every five minutes, for
 * as long as a tab is open.
 *
 * The property these tests pin is **not** "the TTL is five minutes". It is that
 * expiries are *spread*: minting together must not mean expiring together.
 */
describe("projectDirToFolder expiry is spread, not synchronised", () => {
  const TTL = 300_000;
  /**
   * Ask for all 60 distinct names; returns how many `statSync` probes that
   * cost — a **delta**, so a fully-memoised pass reports 0 and a fully-cold one
   * reports the whole decode.
   */
  function askAll(): number {
    const statSync = vi.mocked(mockedStatSync);
    const before = statSync.mock.calls.length;
    for (let i = 0; i < 60; i++) projectDirToFolder(`-none-${i}-x`);
    return statSync.mock.calls.length - before;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.spyOn(Math, "random").mockRestore();
  });

  /** Start a test at a fixed instant with an empty filesystem and empty memo. */
  function freeze() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    setupFS({ dirs: [], files: [], listings: {} });
  }

  it("does not expire every entry at the same instant", () => {
    freeze();
    const cold = askAll();
    expect(cold).toBeGreaterThan(0);

    // One TTL on. With a fixed deadline all 60 would be stale here and this pass
    // would cost the full `cold` again — that is the herd. With spread expiries
    // roughly half are stale, so it costs a fraction.
    vi.setSystemTime(Date.now() + TTL);
    const atOneTtl = askAll();

    expect(atOneTtl, "something expired — this is still a TTL").toBeGreaterThan(0);
    expect(atOneTtl, "but nothing like all of it at once").toBeLessThan(cold * 0.9);
  });

  it("keeps the window at [half, one and a half) TTLs, so the mean is the TTL", () => {
    freeze();
    const cold = askAll();

    // Nothing may expire before half a TTL...
    vi.setSystemTime(Date.now() + TTL * 0.5 - 1);
    expect(askAll(), "nothing expires before half a TTL").toBe(0);

    // ...and everything must have expired by one and a half, which costs
    // exactly what a cold pass costs because every entry is re-probed.
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z").getTime() + TTL * 1.5);
    expect(askAll(), "everything has expired by one and a half TTLs").toBe(cold);
  });

  it("still answers from the memo within an entry's own window", () => {
    // The spread must not cost the memo its job: a decode taken now is still
    // reused two minutes later, which is the case every poll actually hits.
    freeze();
    askAll();

    for (let minute = 1; minute <= 2; minute++) {
      vi.setSystemTime(Date.now() + 60_000);
      expect(askAll(), `minute ${minute} is still inside every entry's window`).toBe(0);
    }
  });
});
