// @vitest-environment jsdom
/**
 * Approving a stale plan review sends a canned reply ("Proceed with the
 * plan.") through `handleSend`. That reply is not the composer's contents, so
 * it must not retire a draft the user just opened in the composer. It used to
 * clear the open draft's id and restore mid-flight without deleting the
 * draft: the restore then landed anyway, the user's own send of the draft no
 * longer retired it, and a stray copy stayed in Staging.
 *
 * Mounted on /chat/:id with a transcript ending in an unanswered ExitPlanMode,
 * which is what puts the stale plan review on screen. The composer is a stub
 * that registers the same setters the real one does and honours
 * `sendBlockedReason`.
 */
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Chat from "./Chat";
import { deleteDraft } from "../api";

const STORED_ID = "12345678-1234-4234-8234-123456789abc";
const restore = vi.hoisted(() => ({ release: (_files: File[]) => {} }));

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: "Planning", folder: "/tmp/project", is_git_repo: false, metadata: "{}" })),
  getMessages: vi.fn(async () => [
    { role: "user", type: "text", content: "plan it" },
    { role: "assistant", type: "tool_use", toolName: "ExitPlanMode", toolUseId: "plan-1", content: JSON.stringify({ plan: "1. Do the thing" }) },
  ]),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0 })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
  uploadImages: vi.fn(async (_id: string, files: File[]) => ({ success: true, images: files.map(() => ({ id: "uploaded" })) })),
  fetchDraftImages: vi.fn(
    () =>
      new Promise((resolve) => {
        restore.release = (files: File[]) => resolve(files.map((value) => ({ status: "fulfilled", value })));
      }),
  ),
  deleteDraft: vi.fn(async () => {}),
}));
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => null, useMetadataVersion: () => 0 }));
vi.mock("../components/ChatTreeIndicator", () => ({ default: () => null }));
vi.mock("../components/PromptInput", () => {
  function PromptInputStub({
    onSend,
    sendBlockedReason,
    onSetValue,
    onAddImages,
  }: {
    onSend: (prompt: string, images?: File[]) => void;
    sendBlockedReason?: string;
    onSetValue?: (setter: (value: string | ((current: string) => string)) => void) => void;
    onAddImages?: (add: (files: File[]) => void) => void;
  }) {
    const [text, setText] = useState("");
    const [images, setImages] = useState<File[]>([]);
    useEffect(() => {
      onSetValue?.(() => (value: string | ((current: string) => string)) => setText((cur) => (typeof value === "function" ? value(cur) : value)));
    }, [onSetValue]);
    useEffect(() => {
      onAddImages?.(() => (files: File[]) => setImages((prev) => [...prev, ...files]));
    }, [onAddImages]);
    return (
      <>
        <div data-testid="composer-images">{images.map((f) => f.name).join(",")}</div>
        <div data-testid="send-blocked">{sendBlockedReason ?? ""}</div>
        <button
          type="button"
          onClick={() => {
            if (sendBlockedReason) return;
            onSend(text, images.length > 0 ? images : undefined);
          }}
        >
          send
        </button>
      </>
    );
  }
  return { default: PromptInputStub };
});

const posts: string[] = [];

beforeEach(() => {
  posts.length = 0;
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
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET").toUpperCase() === "POST" && url.endsWith("/message")) {
        posts.push(JSON.parse(String(init!.body)).prompt);
        return { ok: true, status: 200, body: new ReadableStream({ start: (c) => c.close() }), json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("a plan approval mid-restore leaves the opened draft alone, and sending the draft still retires it", async () => {
  render(
    <MemoryRouter initialEntries={[{ pathname: "/chat/planning", state: { draft: { id: "draft-1", user_message: "with pic", images: [{ id: STORED_ID, originalName: "pic.png" }] } } }]}>
      <Routes>
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByTestId("send-blocked").textContent).toMatch(/restoring/i));

  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  });
  await waitFor(() => expect(posts).toEqual(["Proceed with the plan."]));
  expect(deleteDraft).not.toHaveBeenCalled();

  await act(async () => restore.release([new File(["png"], "pic.png", { type: "image/png" })]));
  await waitFor(() => expect(screen.getByTestId("composer-images").textContent).toBe("pic.png"));
  await waitFor(() => expect(screen.getByTestId("send-blocked").textContent).toBe(""));

  await act(async () => {
    fireEvent.click(screen.getByText("send"));
  });
  await waitFor(() => expect(posts).toEqual(["Proceed with the plan.", "with pic"]));
  await waitFor(() => expect(deleteDraft).toHaveBeenCalledWith("draft-1"));
});
