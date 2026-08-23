// @vitest-environment jsdom
/**
 * The half of the problem error boundaries structurally cannot reach.
 *
 * These assertions are as narrow as the feature: the two global channels get
 * logged with the same prefix as a boundary crash, and installing twice does
 * not double them. Nothing here claims a rejected promise gets a fallback UI —
 * it does not, and the PR body says so.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installGlobalErrorLogging } from "./globalErrorLogging";

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
  vi.restoreAllMocks();
});

describe("installGlobalErrorLogging", () => {
  it("logs an unhandled rejection with its reason object, so the stack survives", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    uninstall = installGlobalErrorLogging();

    const reason = new Error("fetch blew up in a .then()");
    // jsdom fires no real PromiseRejectionEvent, so dispatch the shape the
    // listener reads: an event carrying `reason`.
    const event = Object.assign(new Event("unhandledrejection"), { reason });
    window.dispatchEvent(event);

    const call = spy.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("Unhandled promise rejection"));
    expect(call).toBeTruthy();
    expect(call?.[1]).toBe(reason);
    expect(String(call?.[0])).toMatch(/no error boundary can catch this/);
  });

  it("logs an uncaught error from outside React", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    uninstall = installGlobalErrorLogging();

    const error = new Error("throw from a click handler");
    window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));

    expect(spy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("Uncaught error"))).toBe(true);
  });

  it("is idempotent — a second install does not double every message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    uninstall = installGlobalErrorLogging();
    const second = installGlobalErrorLogging();

    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("once") }));

    expect(spy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("Unhandled promise rejection")).length).toBe(1);
    second();
  });
});
