import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installProcessGuards, uninstallProcessGuards } from "./process-guards.js";

/**
 * Tests for the process-level unhandledRejection / uncaughtException guards.
 *
 * The handlers are exercised directly (via the references returned from
 * installProcessGuards) instead of process.emit(...) — emitting a real
 * "unhandledRejection" event would also invoke vitest's own listener and
 * fail the run as a genuine unhandled rejection.
 */
describe("process guards", () => {
  const logger = { error: vi.fn() };
  const exit = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    logger.error.mockClear();
    exit.mockClear();
  });

  afterEach(() => {
    uninstallProcessGuards();
    vi.useRealTimers();
  });

  describe("registration", () => {
    it("registers one listener for each event", () => {
      const rejectionBefore = process.listenerCount("unhandledRejection");
      const exceptionBefore = process.listenerCount("uncaughtException");

      installProcessGuards({ logger, exit });

      expect(process.listenerCount("unhandledRejection")).toBe(rejectionBefore + 1);
      expect(process.listenerCount("uncaughtException")).toBe(exceptionBefore + 1);
    });

    it("is idempotent — a second install adds no listeners and returns the same handlers", () => {
      const first = installProcessGuards({ logger, exit });
      const rejectionAfterFirst = process.listenerCount("unhandledRejection");
      const exceptionAfterFirst = process.listenerCount("uncaughtException");

      const second = installProcessGuards({ logger, exit });

      expect(second).toBe(first);
      expect(process.listenerCount("unhandledRejection")).toBe(rejectionAfterFirst);
      expect(process.listenerCount("uncaughtException")).toBe(exceptionAfterFirst);
    });

    it("uninstall removes the listeners and allows reinstall", () => {
      const rejectionBefore = process.listenerCount("unhandledRejection");

      const first = installProcessGuards({ logger, exit });
      uninstallProcessGuards();
      expect(process.listenerCount("unhandledRejection")).toBe(rejectionBefore);

      const second = installProcessGuards({ logger, exit });
      expect(second).not.toBe(first);
      expect(process.listenerCount("unhandledRejection")).toBe(rejectionBefore + 1);
    });
  });

  describe("unhandledRejection", () => {
    it("logs an Error reason with its stack and does NOT exit", () => {
      const { onUnhandledRejection } = installProcessGuards({ logger, exit });

      const err = new Error('Response failed: {"code":"server_error","message":"Internal Server Error"}');
      onUnhandledRejection(err);

      expect(logger.error).toHaveBeenCalledTimes(1);
      const message = logger.error.mock.calls[0][0] as string;
      expect(message).toContain("Unhandled promise rejection");
      expect(message).toContain("Response failed");
      expect(message).toContain("process-guards.test"); // stack frame present

      vi.runAllTimers();
      expect(exit).not.toHaveBeenCalled();
    });

    it("logs non-Error reasons without throwing", () => {
      const { onUnhandledRejection } = installProcessGuards({ logger, exit });

      onUnhandledRejection({ code: "server_error" });
      onUnhandledRejection(undefined);

      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error.mock.calls[0][0]).toContain('{"code":"server_error"}');
      expect(exit).not.toHaveBeenCalled();
    });
  });

  describe("uncaughtException", () => {
    it("logs the error, then exits non-zero after the flush grace period", () => {
      const { onUncaughtException } = installProcessGuards({ logger, exit });

      onUncaughtException(new Error("boom"), "uncaughtException");

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][0]).toContain("boom");
      // Exits only after the flush grace period, not synchronously
      expect(exit).not.toHaveBeenCalled();

      vi.runAllTimers();
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
