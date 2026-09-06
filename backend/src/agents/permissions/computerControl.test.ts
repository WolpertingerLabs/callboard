import { expect, it } from "vitest";
import type { DefaultPermissions } from "shared/types/index.js";
import { decidePermission } from "./ToolPermissionPolicy.js";
import { openCodePermissionConfig } from "../adapters/acp/vendors.js";

it("computerControl denies additionally, delegates scoped asks to service, never duplicates prompts", () => {
  const defaults: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", computerControl: "ask" };
  expect(decidePermission("computerControl", defaults)).toBe("allow");
  expect(decidePermission("computerControl", null)).toBe("allow");
  expect(decidePermission("computerControl", { ...defaults, computerControl: "deny" })).toBe("deny");
  expect(decidePermission("fileWrite", { ...defaults, fileWrite: "ask" })).toBe("ask");
});

it("OpenCode fifth-axis deny/ask does not disable task; both wildcard branches defer managed tools to service", () => {
  for (const computerControl of ["deny", "ask", "allow"] as const) {
    const defaults: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", computerControl };
    const allowed = JSON.parse(openCodePermissionConfig(defaults)).permission;
    expect(allowed["*"]).toBe("allow");
    expect(allowed.task).toBeUndefined();
    const asking = JSON.parse(openCodePermissionConfig({ ...defaults, fileWrite: "ask" })).permission;
    expect(asking["*"]).toBe("ask");
    expect(asking.task).toBe("deny");
    for (const config of [allowed, asking]) {
      expect(config["computer_use_*"]).toBe("allow");
      expect(config["cu_*"]).toBe("allow");
    }
  }
});
