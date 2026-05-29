import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIgnoredProjectFolder, projectDirToFolder, saveIgnoredProjectDirPrefixes } from "./paths.js";

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
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDirectories = new Set();
  mockFiles = new Set();
  mockDirEntries = new Map();
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
  beforeEach(() => {
    // Point the prefix-config at a throwaway dir so we never touch the real
    // ~/.callboard config, then prime the in-memory cache with known prefixes.
    process.env.CALLBOARD_DATA_DIR = join(tmpdir(), `cb-paths-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    saveIgnoredProjectDirPrefixes(["-tmp", "-private-"]);
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
