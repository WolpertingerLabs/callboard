import { describe, it, expect } from "vitest";
import { migratePermissions } from "./migrate-permissions.js";

describe("migratePermissions", () => {
  describe("null/undefined input", () => {
    it("returns null for null", () => {
      expect(migratePermissions(null)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(migratePermissions(undefined)).toBeNull();
    });

    it("returns null for empty object (no recognizable format)", () => {
      expect(migratePermissions({})).toBeNull();
    });
  });

  describe("new format (4-category) passthrough", () => {
    it("returns permissions as-is when already in new format", () => {
      const permissions = {
        fileRead: "allow" as const,
        fileWrite: "ask" as const,
        codeExecution: "deny" as const,
        webAccess: "allow" as const,
      };
      expect(migratePermissions(permissions)).toEqual(permissions);
    });

    it("passes through all-allow permissions", () => {
      const permissions = {
        fileRead: "allow" as const,
        fileWrite: "allow" as const,
        codeExecution: "allow" as const,
        webAccess: "allow" as const,
      };
      expect(migratePermissions(permissions)).toEqual(permissions);
    });
  });

  describe("old format (3-category) migration", () => {
    it("splits fileOperations into fileRead + fileWrite", () => {
      const old = {
        fileOperations: "allow" as const,
        codeExecution: "deny" as const,
        webAccess: "ask" as const,
      };
      expect(migratePermissions(old)).toEqual({
        fileRead: "allow",
        fileWrite: "allow",
        codeExecution: "deny",
        webAccess: "ask",
      });
    });

    it("defaults codeExecution to 'ask' when missing", () => {
      const old = { fileOperations: "allow" as const };
      const result = migratePermissions(old);
      expect(result?.codeExecution).toBe("ask");
    });

    it("defaults webAccess to 'ask' when missing", () => {
      const old = { fileOperations: "deny" as const };
      const result = migratePermissions(old);
      expect(result?.webAccess).toBe("ask");
    });

    it("preserves deny across all categories", () => {
      const old = {
        fileOperations: "deny" as const,
        codeExecution: "deny" as const,
        webAccess: "deny" as const,
      };
      expect(migratePermissions(old)).toEqual({
        fileRead: "deny",
        fileWrite: "deny",
        codeExecution: "deny",
        webAccess: "deny",
      });
    });
  });
});
