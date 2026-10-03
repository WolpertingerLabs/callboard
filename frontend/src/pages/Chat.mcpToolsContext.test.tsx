/**
 * The MCP tool list is fetched per tool-set context, not once per mount.
 *
 * Chat is not remounted between chats (`/chat/new` and `/chat/:id` render the
 * same instance), and agent sessions run with a different tool set from
 * ordinary ones. The list used to be fetched once and then kept — the effect
 * bailed whenever a list was already loaded — so whichever kind of chat was
 * opened first decided the tools the browser listed for every chat after it.
 *
 * It must also not cost requests: moving between two chats of the same kind
 * refetches nothing, and an existing chat waits for its own record rather than
 * guessing a context and correcting it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import Chat from "./Chat";
import { getChat, getMcpTools, listKeywords, type McpToolsResponse } from "../api";

const tools = (n: number, server: string): McpToolsResponse => ({
  tools: Array.from({ length: n }, (_, i) => ({
    name: `${server}_${i}`,
    qualifiedName: `mcp__${server}__t${i}`,
    description: "",
    parameters: [],
    serverName: server,
    serverLabel: server,
    category: "platform",
  })),
  servers: [],
});
const AGENT_TOOLS = tools(3, "agent");
const CHAT_TOOLS = tools(1, "chat");

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({
    id,
    folder: "/tmp",
    is_git_repo: false,
    metadata: id.startsWith("agent") ? JSON.stringify({ agentAlias: "forge" }) : "{}",
  })),
  getMessages: vi.fn(async () => []),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0 })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async (context?: string) => (context === "agent" ? AGENT_TOOLS : CHAT_TOOLS)),
  listKeywords: vi.fn(async () => []),
  getNewChatInfo: vi.fn(async (folder: string) => ({ folder, is_git_repo: false, slash_commands: [], plugins: [] })),
  getCard: vi.fn(async () => {
    throw new Error("no card");
  }),
}));
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => null, useMetadataVersion: () => 0 }));
vi.mock("../hooks/useResolvedFavorites", () => ({
  useResolvedFavorites: () => ({
    skills: [],
    jobs: [],
    missingSkills: [],
    missingJobs: [],
    settled: true,
    jobsResolved: true,
    error: null,
    retry: () => {},
    dropMissing: () => {},
  }),
}));
vi.mock("../components/PromptInput", () => ({ default: () => <textarea aria-label="Composer" /> }));
vi.mock("../components/ChatTreeIndicator", () => ({ default: () => null }));
vi.mock("../components/GitDiffView", () => ({ default: () => null }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => null }));

/** Buttons that navigate in-app, the way the sidebar and New Chat panel do. */
function Nav() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/chat/new?folder=/tmp", { state: { agentAlias: "forge" } })}>new agent chat</button>
      <button onClick={() => navigate("/chat/new?folder=/tmp")}>new chat</button>
      <button onClick={() => navigate("/chat/new?folder=/elsewhere")}>new chat elsewhere</button>
      <button onClick={() => navigate("/chat/agent-1")}>agent-1</button>
      <button onClick={() => navigate("/chat/agent-2")}>agent-2</button>
      <button onClick={() => navigate("/chat/plain-1")}>plain-1</button>
      <button onClick={() => navigate("/chat/plain-2")}>plain-2</button>
    </>
  );
}

function mount(entry: string | { pathname: string; search?: string; state?: unknown }) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Nav />
      <Routes>
        <Route path="/chat/new" element={<Chat />} />
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function go(label: string) {
  await act(async () => {
    fireEvent.click(screen.getByText(label));
  });
}

/** The new-chat screen's Tools pill shows how many tools are listed. */
const toolsPill = () => screen.getByRole("button", { name: /^Tools/ });

/** Let every pending fetch settle, then say which contexts were requested. */
async function contexts() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return vi.mocked(getMcpTools).mock.calls.map(([context]) => context ?? "default");
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  for (const name of ["IntersectionObserver", "ResizeObserver"])
    vi.stubGlobal(
      name,
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("MCP tools follow the chat's tool-set context", () => {
  it("an agent compose screen, then an ordinary one, refetches with the ordinary context", async () => {
    mount({ pathname: "/chat/new", search: "?folder=/tmp", state: { agentAlias: "forge" } });
    await waitFor(() => expect(toolsPill().textContent).toContain("3"));
    expect(await contexts()).toEqual(["agent"]);

    await go("new chat");
    await waitFor(() => expect(toolsPill().textContent).toContain("1"));
    expect(await contexts()).toEqual(["agent", "default"]);

    // Same instance throughout — the stale list was never a remount problem.
    expect(listKeywords).toHaveBeenCalledTimes(1);
  });

  it("moving between chats of the same kind refetches nothing", async () => {
    mount({ pathname: "/chat/new", search: "?folder=/tmp" });
    await waitFor(() => expect(toolsPill().textContent).toContain("1"));

    await go("new chat elsewhere");
    await go("plain-1");
    await waitFor(() => expect(getChat).toHaveBeenCalledWith("plain-1"));
    await go("plain-2");
    await waitFor(() => expect(getChat).toHaveBeenCalledWith("plain-2"));
    expect(await contexts()).toEqual(["default"]);

    await go("new agent chat");
    await waitFor(() => expect(toolsPill().textContent).toContain("3"));
    await go("agent-1");
    await waitFor(() => expect(getChat).toHaveBeenCalledWith("agent-1"));
    await go("agent-2");
    await waitFor(() => expect(getChat).toHaveBeenCalledWith("agent-2"));
    expect(await contexts()).toEqual(["default", "agent"]);
  });

  it("an existing chat's context comes from its own metadata, once its record has loaded", async () => {
    mount("/chat/agent-1");
    await waitFor(() => expect(getMcpTools).toHaveBeenCalled());
    // Not a default-context fetch first, corrected once the record arrives.
    expect(await contexts()).toEqual(["agent"]);

    await go("plain-1");
    await waitFor(() => expect(getMcpTools).toHaveBeenCalledTimes(2));
    expect(await contexts()).toEqual(["agent", "default"]);

    // An agent compose screen landing on its own new chat keeps its tools.
    await go("new agent chat");
    await go("agent-2");
    await waitFor(() => expect(getChat).toHaveBeenCalledWith("agent-2"));
    expect(await contexts()).toEqual(["agent", "default", "agent"]);
  });

  it("a list that arrives after the context moved on is dropped", async () => {
    let resolveAgent!: (value: McpToolsResponse) => void;
    vi.mocked(getMcpTools).mockImplementationOnce(() => new Promise((resolve) => (resolveAgent = resolve)));
    mount({ pathname: "/chat/new", search: "?folder=/tmp", state: { agentAlias: "forge" } });
    await waitFor(() => expect(getMcpTools).toHaveBeenCalledWith("agent"));

    await go("new chat");
    await waitFor(() => expect(toolsPill().textContent).toContain("1"));

    await act(async () => resolveAgent(AGENT_TOOLS));
    expect(toolsPill().textContent).toContain("1");
  });

  it("a chat whose record fails to load still lists the ordinary tools, with one request", async () => {
    vi.mocked(getChat).mockRejectedValueOnce(new Error("Failed to get chat"));
    mount("/chat/missing");
    await waitFor(() => expect(getMcpTools).toHaveBeenCalled());
    expect(await contexts()).toEqual(["default"]);

    fireEvent.click(screen.getByTitle("View available MCP tools"));
    await waitFor(() => expect(screen.queryByText("Loading tools...")).toBeNull());
    expect(screen.queryByText("No MCP tools available.")).toBeNull();
  });

  it("a chat opened under an id that is not its record's id (a session id) still gets its tools", async () => {
    // The backend resolves /chat/<sessionId> too, and answers with the chat's own id.
    vi.mocked(getChat).mockResolvedValueOnce({
      id: "chat-uuid",
      session_id: "session-1",
      folder: "/tmp",
      is_git_repo: false,
      metadata: JSON.stringify({ agentAlias: "forge" }),
    } as unknown as Awaited<ReturnType<typeof getChat>>);
    mount("/chat/session-1");
    await waitFor(() => expect(getMcpTools).toHaveBeenCalled());
    expect(await contexts()).toEqual(["agent"]);

    fireEvent.click(screen.getByTitle("View available MCP tools"));
    await waitFor(() => expect(screen.queryByText("Loading tools...")).toBeNull());
    expect(screen.queryByText("No MCP tools available.")).toBeNull();
  });

  it("shows the tools as loading, not empty, while an existing chat's record is still on its way", async () => {
    let resolveChat!: (chat: Awaited<ReturnType<typeof getChat>>) => void;
    vi.mocked(getChat).mockImplementationOnce(() => new Promise((resolve) => (resolveChat = resolve)));
    mount("/chat/plain-1");
    await act(async () => {
      fireEvent.click(screen.getByTitle("View available MCP tools"));
    });
    expect(screen.getByText("Loading tools...")).toBeTruthy();
    expect(screen.queryByText("No MCP tools available.")).toBeNull();
    expect(getMcpTools).not.toHaveBeenCalled();

    await act(async () => resolveChat({ id: "plain-1", folder: "/tmp", metadata: "{}" } as Awaited<ReturnType<typeof getChat>>));
    await waitFor(() => expect(screen.queryByText("Loading tools...")).toBeNull());
    expect(screen.queryByText("No MCP tools available.")).toBeNull();
    expect(await contexts()).toEqual(["default"]);
  });
});
