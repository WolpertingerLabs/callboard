/**
 * The agent-facing MCP surface is blind in the same way the HTTP route was: it
 * hands the model a small error object and returns. These pin that a driver
 * fault reaches the operator's log, and that the routine "no active turn"
 * refusal does not.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";

const logs = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ createLogger: () => logs, default: () => logs }));
vi.mock("./computer-use.js", async (original) => ({
  ...(await original<typeof import("./computer-use.js")>()),
  getComputerUseHost: vi.fn(),
}));

import { ComputerUseHost, getComputerUseHost } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { beginComputerUseTurn, buildComputerUseToolsSpec, closeComputerUseConnections } from "./computer-use-tools.js";

let host: ComputerUseHost | undefined;
beforeEach(() => {
  logs.error.mockClear();
  logs.warn.mockClear();
  logs.debug.mockClear();
});
afterEach(async () => {
  await closeComputerUseConnections();
  await host?.dispose();
  host = undefined;
});

it("records a driver fault the model only sees as an error tool result", async () => {
  const driver: Driver = {
    kind: "browser",
    probe: async () => ({ kind: "browser", available: true, capabilities: ["screenshot"] }),
    open: async () => ({
      act: async () => {},
      close: async () => {},
      releaseInput: async () => {},
      observe: async () => {
        throw new Error("Target page, context or browser has been closed");
      },
    }),
  };
  const service = new ComputerUseService({
    targets: [{ id: "managed-browser", enabled: true, driver }],
    authorize: (request) => host?.authorize(request) ?? "deny",
  });
  host = new ComputerUseHost(service, { browser: driver, desktop: { ...driver, kind: "native-desktop" } }, () => ({
    policy: readComputerUsePolicy({ computerControl: "allow", webAccess: "allow" }),
    signature: "scope",
  }));
  vi.mocked(getComputerUseHost).mockResolvedValue(host);
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await host.open("chat", "browser");

  const result = await buildComputerUseToolsSpec(() => "chat")
    .tools.find((item) => item.name === "cu_observe")!
    .handler({ sessionId: opened.id, generation: opened.generation });
  end();

  expect(result.isError).toBe(true);
  expect(logs.error).toHaveBeenCalledOnce();
  expect(String(logs.error.mock.calls[0][0])).toContain(`computer_observe chat=chat session=${opened.id} code=driver_error`);
});

it("does not log a refusal from an idle facade at error level", async () => {
  const result = await buildComputerUseToolsSpec(() => "idle")
    .tools.find((item) => item.name === "cu_observe")!
    .handler({ sessionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", generation: 1 });

  expect(result.isError).toBe(true);
  expect(logs.error).not.toHaveBeenCalled();
  expect(logs.warn).not.toHaveBeenCalled();
  expect(String(logs.debug.mock.calls.at(0)?.[0])).toContain("code=cancelled");
});
