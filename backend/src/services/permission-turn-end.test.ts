import { describe, expect, it } from "vitest";
import { describeDeniedTurnEnd, isTurnEndDiagnosticOnly, isRethrownTurnEndDiagnostic } from "./permission-turn-end.js";

// Verbatim from production logs (Claude Code 2.1.326, 2026-11-18 → 11-26).
const EDE = "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use";

describe("isTurnEndDiagnosticOnly", () => {
  it("matches a reason made only of the CLI's turn-end diagnostic", () => {
    expect(isTurnEndDiagnosticOnly(EDE)).toBe(true);
    // The adapter joins `errors[]` with "; ".
    expect(isTurnEndDiagnosticOnly(`${EDE}; ${EDE}`)).toBe(true);
  });

  it("does not match a reason that carries a real error alongside or instead", () => {
    expect(isTurnEndDiagnosticOnly(`${EDE}; API Error: 529 overloaded`)).toBe(false);
    expect(isTurnEndDiagnosticOnly("API Error: 529 overloaded")).toBe(false);
    expect(isTurnEndDiagnosticOnly(undefined)).toBe(false);
    expect(isTurnEndDiagnosticOnly("")).toBe(false);
  });
});

describe("describeDeniedTurnEnd", () => {
  it("names the tool and the denial instead of the raw diagnostic", () => {
    const text = describeDeniedTurnEnd({ toolName: "Write", message: "Auto-denied by default fileWrite policy" });
    expect(text).toContain("Write");
    expect(text).toContain("Auto-denied by default fileWrite policy");
    expect(text).not.toContain("ede_diagnostic");
  });
});

describe("describeDeniedTurnEnd — a person's Deny", () => {
  it("says the user denied it, without pointing them at the chat's permissions", () => {
    const text = describeDeniedTurnEnd({ toolName: "Bash", message: "User denied", byUser: true });
    expect(text).toContain("Bash");
    expect(text).toMatch(/you denied/i);
    expect(text).not.toMatch(/permissions/i);
  });

  it("keeps the policy wording for an automatic deny", () => {
    expect(describeDeniedTurnEnd({ toolName: "Write", message: "Auto-denied by default fileWrite policy", byUser: false })).toMatch(/permissions/);
  });
});

describe("isRethrownTurnEndDiagnostic", () => {
  it("matches the SDK's rethrow of a diagnostic-only error result", () => {
    expect(isRethrownTurnEndDiagnostic(`Claude Code returned an error result: ${EDE}`)).toBe(true);
  });

  it("does not match other errors", () => {
    expect(isRethrownTurnEndDiagnostic("Claude Code returned an error result: API Error: 401")).toBe(false);
    expect(isRethrownTurnEndDiagnostic(EDE)).toBe(false);
    expect(isRethrownTurnEndDiagnostic(undefined)).toBe(false);
  });
});
