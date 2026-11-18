import { expect, it } from "vitest";
import type { DefaultPermissions } from "shared/types/index.js";
import { decidePermission } from "./ToolPermissionPolicy.js";

it("computerControl denies additionally, delegates scoped asks to service, never duplicates prompts", () => {
  const defaults: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", computerControl: "ask" };
  expect(decidePermission("computerControl", defaults)).toBe("allow");
  expect(decidePermission("computerControl", { ...defaults, computerControl: "allow" })).toBe("allow");
  expect(decidePermission("computerControl", { ...defaults, computerControl: "deny" })).toBe("deny");
  expect(decidePermission("fileWrite", { ...defaults, fileWrite: "ask" })).toBe("ask");
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
