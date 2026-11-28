import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoConfigStatus } from "../api";

const h = vi.hoisted(() => ({
  status: null as RepoConfigStatus | null,
  getRepoConfigStatus: vi.fn(),
  trustFolder: vi.fn(),
}));
vi.mock("../api", () => ({
  getRepoConfigStatus: (...args: unknown[]) => h.getRepoConfigStatus(...args),
  trustFolder: (...args: unknown[]) => h.trustFolder(...args),
}));

const { default: RepoConfigNotice, describeDefines } = await import("./RepoConfigNotice");

const DEFINES = { hookEvents: ["PreToolUse", "SessionStart"], statusLine: false, helpers: ["apiKeyHelper"], mcpJsonServers: ["evil"] };
const NOTHING = { hookEvents: [], statusLine: false, helpers: [], mcpJsonServers: [] };
const status = (over: Partial<RepoConfigStatus>): RepoConfigStatus => ({ folder: "/repo", trusted: false, mode: "trusted", defines: DEFINES, ...over });

beforeEach(() => {
  h.getRepoConfigStatus.mockReset().mockImplementation(async () => h.status);
  h.trustFolder.mockReset().mockResolvedValue({ path: "/repo", addedAt: "x" });
});
afterEach(cleanup);

describe("RepoConfigNotice", () => {
  it("renders nothing when the folder defines nothing, or the config will run", async () => {
    h.status = status({ defines: NOTHING, decision: { run: false, reason: "untrusted-folder" } });
    const { container, rerender } = render(<RepoConfigNotice folder="/repo" codeExecution="allow" />);
    await waitFor(() => expect(h.getRepoConfigStatus).toHaveBeenCalledWith("/repo", "allow", expect.anything()));
    expect(container.innerHTML).toBe("");
    h.status = status({ trusted: true, decision: { run: true, reason: "trusted" } });
    rerender(<RepoConfigNotice folder="/repo" codeExecution="deny" />);
    await waitFor(() => expect(h.getRepoConfigStatus).toHaveBeenCalledTimes(2));
    expect(container.innerHTML).toBe("");
  });

  it("asks nothing for a non-Claude harness or a relative path", async () => {
    render(<RepoConfigNotice folder="/repo" codeExecution="allow" provider="codex" />);
    render(<RepoConfigNotice folder="repo" codeExecution="allow" />);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.getRepoConfigStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["code-execution-not-allowed", /Code execution for this chat isn't Allow/],
    ["setting-never", /Repository hooks setting is Never/],
  ] as const)("%s: says why, with no trust button", async (reason, text) => {
    h.status = status({ decision: { run: false, reason } });
    render(<RepoConfigNotice folder="/repo" codeExecution="ask" />);
    expect((await screen.findByTestId("repo-config-notice")).textContent).toMatch(text);
    expect(screen.getByTestId("repo-config-notice").textContent).toMatch(/~\/\.claude hooks are off for this chat too/);
    expect(screen.queryByRole("button", { name: "Trust this folder" })).toBeNull();
  });

  it("untrusted-folder: offers Trust, which trusts the folder and re-reads", async () => {
    h.status = status({ decision: { run: false, reason: "untrusted-folder" } });
    render(<RepoConfigNotice folder="/repo" codeExecution="allow" existingChat />);
    const notice = await screen.findByTestId("repo-config-notice");
    expect(notice.textContent).toMatch(/this folder isn't trusted/);
    expect(notice.textContent).toMatch(/next message/);
    h.status = status({ trusted: true, decision: { run: true, reason: "trusted" } });
    fireEvent.click(screen.getByRole("button", { name: "Trust this folder" }));
    await waitFor(() => expect(h.trustFolder).toHaveBeenCalledWith("/repo"));
    await waitFor(() => expect(screen.queryByTestId("repo-config-notice")).toBeNull());
  });

  it("shows a trust failure", async () => {
    h.status = status({ decision: { run: false, reason: "untrusted-folder" } });
    h.trustFolder.mockRejectedValue(new Error("Folder does not exist: /repo"));
    render(<RepoConfigNotice folder="/repo" codeExecution="allow" />);
    fireEvent.click(await screen.findByRole("button", { name: "Trust this folder" }));
    expect(await screen.findByText("Folder does not exist: /repo")).toBeTruthy();
  });
});

describe("describeDefines", () => {
  it("lists what is defined, in prose", () => {
    expect(describeDefines(DEFINES)).toBe("hooks (PreToolUse, SessionStart), a credential helper (apiKeyHelper) and MCP servers in .mcp.json (evil)");
    expect(describeDefines({ ...NOTHING, statusLine: true })).toBe("a status line command");
  });
});
