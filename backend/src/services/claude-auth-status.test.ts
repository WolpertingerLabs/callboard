/**
 * The login modal's whole input.
 *
 * The case this suite exists for is the first one: a daemon whose only Claude
 * credential is an API key configured in Settings. Chats on it work — the
 * daemon injects `ANTHROPIC_API_KEY` into every one — and the old
 * implementation asked `claude auth status`, a CLI that cannot see Callboard's
 * settings file, so it answered "not logged in" and the modal fired on every
 * page load for the rest of the install's life.
 *
 * `claude auth status` is mocked because it is a process spawn; the credential
 * lookup and the binary resolver are mocked because each has its own suite
 * driving real files. What is under test here is the *decision*: which source
 * is consulted, in what order, and what the answer says when there is nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveClaudeBinary: vi.fn(),
  claudeCodeCredentials: vi.fn(),
  getSdkInfoAsync: vi.fn(),
  execFileAsync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const execFile: any = () => {
    throw new Error("callback-style execFile is not used here");
  };
  execFile[promisify.custom] = (...args: unknown[]) => mocks.execFileAsync(...args);
  return { ...(await importOriginal<typeof import("node:child_process")>()), execFile };
});

vi.mock("./claude-binary.js", () => ({ resolveClaudeBinary: mocks.resolveClaudeBinary }));
vi.mock("./engine-status.js", () => ({ claudeCodeCredentials: mocks.claudeCodeCredentials }));
vi.mock("./sdk-info.js", () => ({ getSdkInfoAsync: mocks.getSdkInfoAsync }));

const { getClaudeAuthStatus, resetClaudeAuthStatusCache } = await import("./claude-auth-status.js");

/** What `claude auth status` prints on a signed-in machine. */
const CLI_SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "user@example.com", subscriptionType: "max" });

beforeEach(() => {
  vi.clearAllMocks();
  resetClaudeAuthStatusCache();
  mocks.resolveClaudeBinary.mockReturnValue({});
  mocks.claudeCodeCredentials.mockResolvedValue({ configured: false, note: "The Agent SDK reported no account." });
  mocks.getSdkInfoAsync.mockResolvedValue({ account: null, models: [], fetchedAt: 0 });
  mocks.execFileAsync.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
});

describe("a credential Callboard configured", () => {
  it("REPRODUCED: an API-key-only daemon needs no login, and spawns nothing to say so", async () => {
    // Measured on an isolated daemon with `apiKey` set, no CLI login and no
    // native `claude`: this endpoint returned `{"loggedIn": false, "error":
    // "CLI error: Command failed: claude auth status … claude: not found"}`
    // while `GET /api/engines` reported `configured: true, source: "API key
    // (ANTHROPIC_API_KEY)"` on the same daemon at the same moment.
    mocks.claudeCodeCredentials.mockResolvedValue({ configured: true, source: "API key (ANTHROPIC_API_KEY)" });

    const status = await getClaudeAuthStatus();
    expect(status.loggedIn).toBe(true);
    expect(status.authMethod).toBe("API key (ANTHROPIC_API_KEY)");
    expect(mocks.execFileAsync).not.toHaveBeenCalled();
  });

  it("does not spawn the CLI even when there is one to spawn", async () => {
    // The cheap answer is also the decisive one, so the expensive one is not
    // reached — which takes a process spawn off the request path of an endpoint
    // the frontend hits on every load.
    mocks.resolveClaudeBinary.mockReturnValue({ path: "/usr/local/bin/claude", source: "path" });
    mocks.claudeCodeCredentials.mockResolvedValue({ configured: true, source: "openrouter", note: "Routed through OpenRouter." });

    const status = await getClaudeAuthStatus();
    expect(status).toMatchObject({ loggedIn: true, authMethod: "openrouter", note: "Routed through OpenRouter.", cliPath: "/usr/local/bin/claude" });
    expect(mocks.execFileAsync).not.toHaveBeenCalled();
  });

  it("decorates a subscription credential with the account the SDK reported", async () => {
    mocks.claudeCodeCredentials.mockResolvedValue({ configured: true, source: "Claude Max subscription" });
    mocks.getSdkInfoAsync.mockResolvedValue({ account: { email: "user@example.com", subscriptionType: "max" }, models: [], fetchedAt: 0 });

    expect(await getClaudeAuthStatus()).toMatchObject({ loggedIn: true, email: "user@example.com", subscriptionType: "max" });
  });

  it("is not fooled by `configured: \"unknown\"`, which is the SDK failing to answer", async () => {
    // `"unknown"` is not `true`. Treating it as one is how a card — or a modal
    // — asserts a credential nothing observed.
    mocks.claudeCodeCredentials.mockResolvedValue({ configured: "unknown", note: "Could not read account info." });

    const status = await getClaudeAuthStatus();
    expect(status.loggedIn).toBe(false);
    expect(status.error).toMatch(/could not read account info/i);
  });
});

describe("the CLI, as the live second opinion", () => {
  it("is what makes the modal's own Check Again button work", async () => {
    // The credential lookup reads `sdk-info`'s boot-time cache, which a fresh
    // `claude auth login` does not invalidate. Only the CLI sees a login
    // performed since the daemon started, so it has to be asked when the cheap
    // source says there is nothing.
    mocks.resolveClaudeBinary.mockReturnValue({ path: "/usr/local/bin/claude", source: "path" });
    mocks.execFileAsync.mockResolvedValue({ stdout: CLI_SIGNED_IN, stderr: "" });

    const status = await getClaudeAuthStatus();
    expect(status).toMatchObject({ loggedIn: true, authMethod: "claude.ai", email: "user@example.com", cliPath: "/usr/local/bin/claude" });
    expect(mocks.execFileAsync).toHaveBeenCalledWith("/usr/local/bin/claude", ["auth", "status"], expect.objectContaining({ killSignal: "SIGKILL" }));
  });

  it("runs the resolved path, not a bare name a shell has to find", async () => {
    // The bare-name fallback is what produced "CLI error: … claude: not found"
    // on a machine that had no native CLI and did not need one.
    mocks.resolveClaudeBinary.mockReturnValue({ path: "/opt/mine/claude", source: "setting" });
    mocks.execFileAsync.mockResolvedValue({ stdout: CLI_SIGNED_IN, stderr: "" });

    await getClaudeAuthStatus();
    expect(mocks.execFileAsync.mock.calls[0][0]).toBe("/opt/mine/claude");
  });

  it("reports a CLI that answered but is not signed in", async () => {
    mocks.resolveClaudeBinary.mockReturnValue({ path: "/usr/local/bin/claude", source: "path" });
    mocks.execFileAsync.mockResolvedValue({ stdout: JSON.stringify({ loggedIn: false }), stderr: "" });

    expect(await getClaudeAuthStatus()).toMatchObject({ loggedIn: false, cliPath: "/usr/local/bin/claude" });
  });

  it("survives a credential lookup that throws, rather than reading it as 'not logged in'", async () => {
    mocks.claudeCodeCredentials.mockRejectedValue(new Error("boom"));
    mocks.resolveClaudeBinary.mockReturnValue({ path: "/usr/local/bin/claude", source: "path" });
    mocks.execFileAsync.mockResolvedValue({ stdout: CLI_SIGNED_IN, stderr: "" });

    expect((await getClaudeAuthStatus()).loggedIn).toBe(true);
  });
});

describe("nothing at all", () => {
  it("says so without naming a command this machine cannot run", async () => {
    const status = await getClaudeAuthStatus();
    expect(status.loggedIn).toBe(false);
    expect(status.cliPath).toBeUndefined();
    // `claude auth login` is what the modal used to instruct unconditionally.
    // With no CLI, that is advice for a state the user is not in — so the
    // answer names the settings route instead, and the modal keys on `cliPath`.
    expect(status.error).toMatch(/no native `claude` CLI/i);
    expect(mocks.execFileAsync).not.toHaveBeenCalled();
  });
});

describe("caching", () => {
  it("reuses a positive answer", async () => {
    mocks.claudeCodeCredentials.mockResolvedValue({ configured: true, source: "API key (user)" });
    await getClaudeAuthStatus();
    await getClaudeAuthStatus();
    expect(mocks.claudeCodeCredentials).toHaveBeenCalledTimes(1);
  });

  it("never caches a negative, so a login lands on the next Check Again", async () => {
    // The half that matters for the button: caching "no" for a minute would
    // make a user who just logged in press Check Again and be told no again.
    mocks.resolveClaudeBinary.mockReturnValue({ path: "/usr/local/bin/claude", source: "path" });
    mocks.execFileAsync.mockResolvedValue({ stdout: JSON.stringify({ loggedIn: false }), stderr: "" });
    expect((await getClaudeAuthStatus()).loggedIn).toBe(false);

    mocks.execFileAsync.mockResolvedValue({ stdout: CLI_SIGNED_IN, stderr: "" });
    expect((await getClaudeAuthStatus()).loggedIn).toBe(true);
  });
});
