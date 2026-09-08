/**
 * The trace on the one path a non-human caller can still put a non-`deny`
 * `computerControl` on a chat: creating it.
 *
 * `PATCH /:id/permissions` refuses to *change* the axis for anyone but a
 * same-origin session (chats.permissions-auth.test.ts). Creation is
 * deliberately not blocked — passing permissions is the documented purpose of
 * the parameter, and a brand-new chat has no prior human expectation to
 * violate the way a chat already set to `ask` does. So it is recorded instead,
 * and this pins that the record is neither missing nor noise.
 */
import { beforeEach, expect, it, vi } from "vitest";

const logs = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ createLogger: () => logs, default: () => logs }));

const { noteComputerControlAtCreation } = await import("./computer-use-policy.js");

beforeEach(() => {
  logs.warn.mockClear();
});

const FOUR = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" };

it.each(["allow", "ask"] as const)("records an API key creating a chat with computerControl=%s", (level) => {
  noteComputerControlAtCreation("POST /api/chats", "bearer", { ...FOUR, computerControl: level });

  const line = String(logs.warn.mock.calls.at(-1)?.[0]);
  expect(line).toContain("POST /api/chats");
  expect(line).toContain("bearer");
  expect(line).toContain(`computerControl=${level}`);
});

it("says nothing for the calls that are every ordinary call", () => {
  // A signed-in human, at any level: that is the supported way to set it.
  for (const level of ["allow", "ask", "deny"]) noteComputerControlAtCreation("POST /api/chats", "session", { ...FOUR, computerControl: level });
  // A key, but not asking for computer control — including the shapes every
  // in-repo agent-facing spawn actually sends.
  noteComputerControlAtCreation("POST /api/chats", "bearer", { ...FOUR, computerControl: "deny" });
  noteComputerControlAtCreation("POST /api/chats", "bearer", FOUR);
  noteComputerControlAtCreation("POST /api/chats", "bearer", undefined);

  expect(logs.warn).not.toHaveBeenCalled();
});

it("names an unauthenticated caller rather than printing undefined", () => {
  noteComputerControlAtCreation("POST /api/chats/new/message", undefined, { computerControl: "allow" });
  expect(String(logs.warn.mock.calls.at(-1)?.[0])).toContain("unauthenticated caller");
});
