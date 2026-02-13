import { describe, it, expect } from "vitest";
import { validateFilename } from "./git.js";

describe("validateFilename", () => {
  describe("valid filenames", () => {
    it("accepts a simple filename", () => {
      expect(() => validateFilename("file.txt")).not.toThrow();
    });

    it("accepts a nested path", () => {
      expect(() => validateFilename("src/utils/git.ts")).not.toThrow();
    });

    it("accepts deeply nested paths", () => {
      expect(() =>
        validateFilename("a/b/c/d/e/f/g/file.txt"),
      ).not.toThrow();
    });

    it("accepts filenames with dots", () => {
      expect(() => validateFilename("file.test.ts")).not.toThrow();
    });

    it("accepts dotfiles", () => {
      expect(() => validateFilename(".gitignore")).not.toThrow();
    });

    it("accepts nested dotfiles", () => {
      expect(() => validateFilename("src/.env.local")).not.toThrow();
    });

    // Next.js route patterns
    it("accepts Next.js catch-all route [[...slug]]", () => {
      expect(() =>
        validateFilename(
          "projects/web/app/(home)/rankings/[[...category]]/page.tsx",
        ),
      ).not.toThrow();
    });

    it("accepts Next.js rest params [...params]", () => {
      expect(() =>
        validateFilename("app/shop/[...slug]/page.tsx"),
      ).not.toThrow();
    });

    it("accepts Next.js dynamic route [id]", () => {
      expect(() =>
        validateFilename("app/users/[id]/page.tsx"),
      ).not.toThrow();
    });

    it("accepts Next.js route groups with parentheses", () => {
      expect(() =>
        validateFilename("app/(auth)/login/page.tsx"),
      ).not.toThrow();
    });

    it("accepts Next.js optional catch-all at root", () => {
      expect(() =>
        validateFilename("[[...slug]]/layout.tsx"),
      ).not.toThrow();
    });

    it("accepts multiple Next.js dynamic segments", () => {
      expect(() =>
        validateFilename(
          "app/(dashboard)/[orgId]/projects/[projectId]/[[...tab]]/page.tsx",
        ),
      ).not.toThrow();
    });

    it("accepts filenames containing triple dots in a segment", () => {
      expect(() => validateFilename("docs/ellipsis...txt")).not.toThrow();
    });

    it("accepts filenames with double dots embedded in a segment name", () => {
      expect(() => validateFilename("some..file.txt")).not.toThrow();
    });
  });

  describe("directory traversal attacks", () => {
    it("rejects simple parent traversal", () => {
      expect(() => validateFilename("../etc/passwd")).toThrow(
        "Invalid filename",
      );
    });

    it("rejects double parent traversal", () => {
      expect(() => validateFilename("../../etc/shadow")).toThrow(
        "Invalid filename",
      );
    });

    it("rejects mid-path traversal", () => {
      expect(() => validateFilename("foo/../bar.txt")).toThrow(
        "Invalid filename",
      );
    });

    it("rejects trailing traversal segment", () => {
      expect(() => validateFilename("foo/bar/..")).toThrow("Invalid filename");
    });

    it("rejects bare double dot", () => {
      expect(() => validateFilename("..")).toThrow("Invalid filename");
    });

    it("rejects single dot path segment", () => {
      expect(() => validateFilename("foo/./bar.txt")).toThrow(
        "Invalid filename",
      );
    });

    it("rejects bare single dot", () => {
      expect(() => validateFilename(".")).toThrow("Invalid filename");
    });
  });

  describe("other invalid inputs", () => {
    it("rejects empty string", () => {
      expect(() => validateFilename("")).toThrow("Invalid filename");
    });

    it("rejects absolute path starting with /", () => {
      expect(() => validateFilename("/etc/passwd")).toThrow("Invalid filename");
    });

    it("rejects absolute path with traversal", () => {
      expect(() => validateFilename("/../etc/passwd")).toThrow(
        "Invalid filename",
      );
    });
  });
});
