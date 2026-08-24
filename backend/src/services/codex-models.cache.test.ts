/**
 * The Codex catalog's cache lifetime, driven against a mocked `codex debug
 * models` and a faked clock.
 *
 * The behaviour under test is the one that was missing: this module recorded
 * `fetchedAt` and never read it, so the first answer a daemon got was the only
 * answer it would ever give. That failed in the direction that hurts — install
 * Codex, log in, or upgrade the CLI, and callboard kept serving the static
 * fallback it had picked at boot until someone restarted it.
 *
 * Nothing here spawns a process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `promisify(execFile)` resolves `{ stdout, stderr }` only because Node's real
 * `execFile` carries a `promisify.custom` implementation. A bare `vi.fn()`
 * would lose it and resolve the raw first callback argument, so the module's
 * `const { stdout } = await …` would silently see `undefined` and every test
 * would exercise the fallback path. Re-attaching the symbol keeps the mock
 * honest about the shape the real API promises.
 */
const runCodex = vi.fn<() => Promise<{ stdout: string; stderr: string }>>();

vi.mock("node:child_process", () => {
  const execFile = (() => {
    throw new Error("codex-models must use the promisified form");
  }) as unknown as Record<symbol, unknown>;
  execFile[Symbol.for("nodejs.util.promisify.custom")] = () => runCodex();
  return { execFile };
});

vi.mock("./agent-settings.js", () => ({
  getApiEnvOverrides: vi.fn(() => ({})),
  getCodexExecutablePath: vi.fn(() => "/usr/bin/codex"),
}));

import {
  CODEX_MODELS_RETRY_MS,
  CODEX_MODELS_TTL_MS,
  getCodexModelsAsync,
  refreshCodexModelsCache,
  resetCodexModelsCacheForTesting,
} from "./codex-models.js";
import { getCodexExecutablePath } from "./agent-settings.js";

const mockCodexPath = vi.mocked(getCodexExecutablePath);

/** A `codex debug models` payload listing the given slugs. */
function catalog(...slugs: string[]): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({
      models: slugs.map((slug) => ({ slug, display_name: slug, visibility: "list", supported_in_api: true })),
    }),
    stderr: "",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetCodexModelsCacheForTesting();
  mockCodexPath.mockReturnValue("/usr/bin/codex");
  runCodex.mockReset();
  runCodex.mockResolvedValue(catalog("gpt-5.5"));
});

afterEach(() => {
  vi.useRealTimers();
  resetCodexModelsCacheForTesting();
});

describe("cache lifetime", () => {
  it("serves a live catalog without re-running the CLI", async () => {
    await getCodexModelsAsync();
    vi.advanceTimersByTime(CODEX_MODELS_TTL_MS - 1);
    await getCodexModelsAsync();
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it("re-runs the CLI once the catalog is older than the TTL", async () => {
    expect((await getCodexModelsAsync()).map((m) => m.id)).toEqual(["gpt-5.5"]);

    vi.advanceTimersByTime(CODEX_MODELS_TTL_MS);
    runCodex.mockResolvedValue(catalog("gpt-5.5", "gpt-6"));

    expect((await getCodexModelsAsync()).map((m) => m.id)).toEqual(["gpt-5.5", "gpt-6"]);
    expect(runCodex).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight run between concurrent callers", async () => {
    await Promise.all([getCodexModelsAsync(), getCodexModelsAsync(), getCodexModelsAsync()]);
    expect(runCodex).toHaveBeenCalledTimes(1);
  });
});

describe("the fallback is not sticky", () => {
  it("retries a failed run on the short window, not the full TTL", async () => {
    // The daemon booted before Codex was installed.
    runCodex.mockRejectedValue(new Error("ENOENT"));
    expect((await getCodexModelsAsync()).length).toBeGreaterThan(0);
    expect(runCodex).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CODEX_MODELS_RETRY_MS - 1);
    await getCodexModelsAsync();
    expect(runCodex).toHaveBeenCalledTimes(1);

    // The user installs Codex; the next read past the retry window sees it.
    vi.advanceTimersByTime(1);
    runCodex.mockResolvedValue(catalog("gpt-5.5"));
    expect((await getCodexModelsAsync()).map((m) => m.id)).toEqual(["gpt-5.5"]);
  });

  it("keeps the last live catalog when a refresh fails, rather than falling back", async () => {
    expect((await getCodexModelsAsync()).map((m) => m.id)).toEqual(["gpt-5.5"]);

    vi.advanceTimersByTime(CODEX_MODELS_TTL_MS);
    runCodex.mockRejectedValue(new Error("timed out"));

    // A CLI that hangs once must not cost the user the real list they had.
    expect((await getCodexModelsAsync()).map((m) => m.id)).toEqual(["gpt-5.5"]);
    expect(runCodex).toHaveBeenCalledTimes(2);
  });

  it("does not reject when the binary cannot be resolved", async () => {
    // resolveCodexBin() reads settings and can throw. That happens outside the
    // CLI call, and a rejection would strand the in-flight promise and stop the
    // catalog refreshing for the life of the process.
    mockCodexPath.mockImplementation(() => {
      throw new Error("settings unreadable");
    });

    await expect(getCodexModelsAsync()).resolves.toBeInstanceOf(Array);
    expect(runCodex).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CODEX_MODELS_RETRY_MS);
    mockCodexPath.mockReturnValue("/usr/bin/codex");
    expect((await getCodexModelsAsync()).map((m) => m.id)).toEqual(["gpt-5.5"]);
  });
});

describe("refresh", () => {
  it("re-runs immediately even while the cached catalog is fresh", async () => {
    await getCodexModelsAsync();
    runCodex.mockResolvedValue(catalog("gpt-6"));

    expect((await refreshCodexModelsCache()).models.map((m) => m.id)).toEqual(["gpt-6"]);
  });

  it("ignores a run that was already in flight when settings changed", async () => {
    // The wired caller is a settings save, so this race is ordinary: a slow
    // `codex debug models` against the old binary must not land on top of the
    // answer from the new one.
    let releaseOld: (v: { stdout: string; stderr: string }) => void = () => {};
    runCodex.mockReturnValueOnce(new Promise((resolve) => (releaseOld = resolve)));
    const stale = getCodexModelsAsync();

    runCodex.mockResolvedValue(catalog("gpt-6"));
    expect((await refreshCodexModelsCache()).models.map((m) => m.id)).toEqual(["gpt-6"]);

    releaseOld(catalog("gpt-5.5"));
    await stale;

    expect((await getCodexModelsAsync()).map((m) => m.id)).toEqual(["gpt-6"]);
  });
});
