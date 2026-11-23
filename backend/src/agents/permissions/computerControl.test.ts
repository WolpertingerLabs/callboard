import { expect, it } from "vitest";
import type { DefaultPermissions } from "shared/types/index.js";
import { decidePermission } from "./ToolPermissionPolicy.js";

it("computerControl denies additionally, delegates scoped asks to service, never duplicates prompts", () => {
  const defaults: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", browserControl: "ask", computerControl: "ask" };
  expect(decidePermission("computerControl", defaults)).toBe("allow");
  expect(decidePermission("computerControl", { ...defaults, browserControl: "allow", computerControl: "allow" })).toBe("allow");
  expect(decidePermission("computerControl", { ...defaults, browserControl: "deny", computerControl: "deny" })).toBe("deny");
  expect(decidePermission("fileWrite", { ...defaults, fileWrite: "ask" })).toBe("ask");
});

it("the cu_* transport is denied only when BOTH Browser Use and Computer Use are denied", () => {
  const others = { fileRead: "ask", fileWrite: "ask", codeExecution: "ask", webAccess: "ask" } as const;
  const cases: [string, string, "allow" | "deny"][] = [
    ["deny", "deny", "deny"],
    ["ask", "deny", "allow"],
    ["allow", "deny", "allow"],
    ["deny", "ask", "allow"],
    ["deny", "allow", "allow"],
    ["ask", "allow", "allow"],
  ];
  for (const [browserControl, computerControl, expected] of cases) {
    const perms = { ...others, browserControl, computerControl } as DefaultPermissions;
    expect(decidePermission("computerControl", perms), `${browserControl}/${computerControl}`).toBe(expected);
    expect(decidePermission("browserControl", perms), `${browserControl}/${computerControl}`).toBe(expected);
  }
  // Only Browser Use present, Computer Use absent (and vice versa).
  expect(decidePermission("computerControl", { ...others, browserControl: "ask" } as unknown as DefaultPermissions)).toBe("allow");
  expect(decidePermission("computerControl", { ...others, computerControl: "ask" } as unknown as DefaultPermissions)).toBe("allow");
});

it("Browser Use on allow does not leak into an unrelated category", () => {
  const perms: DefaultPermissions = { fileRead: "ask", fileWrite: "deny", codeExecution: "ask", webAccess: "deny", browserControl: "allow", computerControl: "allow" };
  expect(decidePermission("fileRead", perms)).toBe("ask");
  expect(decidePermission("fileWrite", perms)).toBe("deny");
  expect(decidePermission("webAccess", perms)).toBe("deny");
  expect(decidePermission(null, perms)).toBe("ask");
});

it("an absent computerControl axis is deny, not an implicit ask: legacy records and permission-less chats never opted in", () => {
  // Legacy four-axis record (every chat written before the axis existed).
  const legacy = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" } as unknown as DefaultPermissions;
  expect(decidePermission("computerControl", legacy)).toBe("deny");
  // No permissions at all.
  expect(decidePermission("computerControl", null)).toBe("deny");
  // The other axes keep their historical "missing means ask" reading.
  expect(decidePermission("fileWrite", null)).toBe("ask");
  // A malformed value is not "ask" either.
  expect(decidePermission("computerControl", { ...legacy, computerControl: "yes" as never })).toBe("deny");
});
