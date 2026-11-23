import { describe, expect, it } from "vitest";
import { aggregateControlLevel, axisFor, computerUseScopeError, levelFor, readComputerUsePolicy, type ComputerUsePolicy } from "./computer-use-policy.js";

const ALL_ALLOW = {
  fileRead: "allow",
  fileWrite: "allow",
  codeExecution: "allow",
  webAccess: "allow",
  browserControl: "allow",
  computerControl: "allow",
  sandboxControl: "allow",
} as const;
const policy = (overrides: Partial<Record<keyof ComputerUsePolicy, string>> = {}) => readComputerUsePolicy({ ...ALL_ALLOW, ...overrides });

describe("computer-use host policy", () => {
  it("fails closed for absent, malformed and legacy settings on both control axes", () => {
    for (const value of [undefined, null, false, "allow", {}, { fileRead: "allow" }, { computerControl: "invalid", browserControl: "invalid" }]) {
      expect(readComputerUsePolicy(value).computerControl).toBe("deny");
      expect(readComputerUsePolicy(value).browserControl).toBe("deny");
      expect(readComputerUsePolicy(value).sandboxControl).toBe("deny");
    }
    expect(readComputerUsePolicy({ sandboxControl: "invalid" }).sandboxControl).toBe("deny");
    expect(readComputerUsePolicy(Object.create({ sandboxControl: "allow" })).sandboxControl).toBe("deny");
  });
  it("does not let the sandbox axis stand in for either other control axis, or either of them for it", () => {
    expect(readComputerUsePolicy({ sandboxControl: "allow" })).toMatchObject({ browserControl: "deny", computerControl: "deny" });
    expect(readComputerUsePolicy({ browserControl: "allow", computerControl: "allow" }).sandboxControl).toBe("deny");
  });
  it("does not let one control axis stand in for the other", () => {
    expect(readComputerUsePolicy({ computerControl: "allow" }).browserControl).toBe("deny");
    expect(readComputerUsePolicy({ browserControl: "allow" }).computerControl).toBe("deny");
  });
  it("preserves ask without making it allow", () => {
    expect(readComputerUsePolicy({ browserControl: "ask", computerControl: "ask" })).toMatchObject({ browserControl: "ask", computerControl: "ask" });
  });

  describe("decision table", () => {
    // [target, overrides, expected: undefined = permitted, string = fragment of the refusal]
    const rows: [string, "browser" | "desktop" | "sandbox", Partial<Record<keyof ComputerUsePolicy, string>>, string | undefined][] = [
      ["browser: Browser Use deny", "browser", { browserControl: "deny" }, "Browser Use is denied"],
      ["browser: Browser Use missing", "browser", { browserControl: undefined }, "Browser Use is denied"],
      ["browser: Browser Use ask", "browser", { browserControl: "ask" }, undefined],
      ["browser: Browser Use allow", "browser", {}, undefined],
      ["browser: Web Access deny no longer blocks it", "browser", { webAccess: "deny" }, undefined],
      ["browser: Web Access ask no longer blocks it", "browser", { webAccess: "ask", browserControl: "ask" }, undefined],
      ["browser: Computer Use deny does not block it", "browser", { computerControl: "deny" }, undefined],
      [
        "browser: other axes denied do not block it",
        "browser",
        { fileRead: "deny", fileWrite: "deny", codeExecution: "deny", webAccess: "deny", computerControl: "deny" },
        undefined,
      ],
      ["desktop: Computer Use deny", "desktop", { computerControl: "deny" }, "Computer Use is denied"],
      ["desktop: Computer Use missing", "desktop", { computerControl: undefined }, "Computer Use is denied"],
      ["desktop: Computer Use ask, everything else allow", "desktop", { computerControl: "ask" }, undefined],
      ["desktop: Computer Use allow, everything else allow", "desktop", {}, undefined],
      ["desktop: Browser Use ask blocks it", "desktop", { browserControl: "ask" }, "browserControl"],
      ["desktop: Browser Use deny blocks it", "desktop", { browserControl: "deny" }, "browserControl"],
      ["desktop: Web Access ask blocks it", "desktop", { webAccess: "ask" }, "webAccess"],
      ["desktop: file read ask blocks it", "desktop", { fileRead: "ask" }, "fileRead"],
      ["desktop: file write deny blocks it", "desktop", { fileWrite: "deny" }, "fileWrite"],
      ["desktop: code execution ask blocks it", "desktop", { codeExecution: "ask" }, "codeExecution"],
      ["desktop: Sandbox desktop deny does not block it", "desktop", { sandboxControl: "deny" }, undefined],
      ["desktop: Sandbox desktop missing does not block it", "desktop", { sandboxControl: undefined }, undefined],
      ["browser: Sandbox desktop deny does not block it", "browser", { sandboxControl: "deny" }, undefined],
      ["sandbox: Sandbox desktop deny", "sandbox", { sandboxControl: "deny" }, "Sandbox desktop is denied"],
      ["sandbox: Sandbox desktop missing", "sandbox", { sandboxControl: undefined }, "Sandbox desktop is denied"],
      ["sandbox: Sandbox desktop ask", "sandbox", { sandboxControl: "ask" }, undefined],
      ["sandbox: Sandbox desktop allow", "sandbox", {}, undefined],
      [
        "sandbox: every other axis denied does not block it",
        "sandbox",
        { fileRead: "deny", fileWrite: "deny", codeExecution: "deny", webAccess: "deny", browserControl: "deny", computerControl: "deny" },
        undefined,
      ],
      ["sandbox: Computer Use allow does not stand in for it", "sandbox", { sandboxControl: "deny", computerControl: "allow" }, "Sandbox desktop is denied"],
    ];
    it.each(rows)("%s", (_name, kind, overrides, expected) => {
      const source: Record<string, unknown> = { ...ALL_ALLOW, ...overrides };
      for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete source[key];
      const error = computerUseScopeError(kind, readComputerUsePolicy(source));
      if (expected === undefined) expect(error).toBeUndefined();
      else expect(error).toContain(expected);
    });
  });

  it("a legacy chat with Computer Use allow and no Browser Use loses both targets", () => {
    // Behaviour change: such a chat was browser- and desktop-capable before the split.
    const legacy = readComputerUsePolicy({ fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", computerControl: "allow" });
    expect(computerUseScopeError("browser", legacy)).toContain("Browser Use is denied");
    expect(computerUseScopeError("desktop", legacy)).toContain("browserControl");
  });

  it("reads each target's level from its own axis", () => {
    const p = policy({ browserControl: "ask", computerControl: "allow" });
    expect(levelFor("browser", p)).toBe("ask");
    expect(levelFor("desktop", p)).toBe("allow");
    expect(levelFor("sandbox", policy({ sandboxControl: "ask" }))).toBe("ask");
    expect(levelFor("sandbox", readComputerUsePolicy({ computerControl: "allow", browserControl: "allow" }))).toBe("deny");
    expect([axisFor("browser"), axisFor("desktop"), axisFor("sandbox")]).toEqual(["browserControl", "computerControl", "sandboxControl"]);
  });

  it("aggregates to the most permissive control level", () => {
    expect(aggregateControlLevel(policy({ browserControl: "deny", computerControl: "deny", sandboxControl: "deny" }))).toBe("deny");
    expect(aggregateControlLevel(policy({ browserControl: "ask", computerControl: "deny", sandboxControl: "deny" }))).toBe("ask");
    expect(aggregateControlLevel(policy({ browserControl: "ask", computerControl: "allow" }))).toBe("allow");
    expect(aggregateControlLevel(policy({ browserControl: "allow", computerControl: "deny", sandboxControl: "deny" }))).toBe("allow");
    // The sandbox counts toward the aggregate…
    expect(aggregateControlLevel(policy({ browserControl: "deny", computerControl: "deny", sandboxControl: "ask" }))).toBe("ask");
    // …except for a client that is not shown it.
    expect(aggregateControlLevel(policy({ browserControl: "deny", computerControl: "deny", sandboxControl: "allow" }), ["browser", "desktop"])).toBe("deny");
  });
});
