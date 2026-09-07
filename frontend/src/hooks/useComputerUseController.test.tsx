import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComputerUseStatus } from "shared/types/computerUse.js";
import { computerUseClient as client } from "../api/computerUse";
import { useComputerUseController } from "./useComputerUseController";

vi.mock("../api/computerUse", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/computerUse")>()),
  computerUseClient: { status: vi.fn(), control: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const empty: ComputerUseStatus = { permission: "allow", capabilities: [], sessions: [] };
const session = { id: "s1", kind: "browser" as const, state: "active", generation: 1, controller: null };

it.each(["deny", "ask", "allow", "error"] as const)("does not treat checking or unused %s status as usage", async (permission) => {
  if (permission === "error") vi.mocked(client.status).mockRejectedValue(new Error("offline"));
  else vi.mocked(client.status).mockResolvedValue({ ...empty, permission });
  const { result } = renderHook(() => useComputerUseController("c1"));
  expect(result.current.hasUsage).toBe(false);
  await act(async () => {});
  expect(result.current.hasUsage).toBe(false);
});

it.each(["active", "pending_approval", "stopped"])("latches first %s evidence through error, denial and empty status", async (state) => {
  vi.mocked(client.status).mockResolvedValue(empty);
  const { result } = renderHook(() => useComputerUseController("c1"));
  await act(async () => {});
  vi.mocked(client.status).mockResolvedValue({ ...empty, sessions: [{ ...session, state, generation: state === "pending_approval" ? 0 : 1 }] });
  await act(async () => {
    await result.current.readStatus();
  });
  expect(result.current.hasUsage).toBe(true);
  vi.mocked(client.status).mockRejectedValue(new Error("offline"));
  await act(async () => {
    await result.current.readStatus().catch(() => {});
  });
  expect(result.current.hasUsage).toBe(true);
  vi.mocked(client.status).mockResolvedValue({ ...empty, permission: "deny" });
  await act(async () => {
    await result.current.readStatus();
  });
  expect(result.current.hasUsage).toBe(true);
});

it("learns fenced mutation IDs without display authority, but never from another route or lifetime", async () => {
  vi.mocked(client.status).mockResolvedValue(empty);
  const { result, rerender } = renderHook(({ id }) => useComputerUseController(id), { initialProps: { id: "c1" } });
  await act(async () => {});
  const late = result.current.beginMutation();
  await act(async () => {
    await result.current.readStatus();
  });
  act(() => late(session, false));
  expect(result.current.status?.sessions).toEqual([]);
  expect(result.current.hasUsage).toBe(true);
  rerender({ id: "c2" });
  expect(result.current.hasUsage).toBe(false);
  await act(async () => {});
  act(() => late(session));
  expect(result.current.hasUsage).toBe(false);
  rerender({ id: "c1" });
  await act(async () => {});
  act(() => late(session));
  expect(result.current.hasUsage).toBe(false);
  act(() => result.current.beginMutation()({ id: "invalid", state: "active" }));
  expect(result.current.hasUsage).toBe(false);
});

it("ignores old-route reads even on return to the same chat", async () => {
  let resolve!: (status: ComputerUseStatus) => void;
  vi.mocked(client.status)
    .mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    )
    .mockResolvedValue(empty);
  const { result, rerender } = renderHook(({ id }) => useComputerUseController(id), { initialProps: { id: "c1" } });
  rerender({ id: "c2" });
  await act(async () => {});
  rerender({ id: "c1" });
  await act(async () => {});
  await act(async () => resolve({ ...empty, sessions: [session] }));
  expect(result.current.hasUsage).toBe(false);
});

it("records same-lifetime session evidence from a read rejected by newer display authority", async () => {
  vi.mocked(client.status).mockResolvedValue(empty);
  const { result } = renderHook(() => useComputerUseController("c1"));
  await act(async () => {});
  let resolve!: (status: ComputerUseStatus) => void;
  vi.mocked(client.status).mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const oldRead = result.current.readStatus();
  await act(async () => {
    await result.current.readStatus();
  });
  await act(async () => {
    resolve({ ...empty, sessions: [session] });
    await oldRead;
  });
  expect(result.current.status?.sessions).toEqual([]);
  expect(result.current.hasUsage).toBe(true);
});
