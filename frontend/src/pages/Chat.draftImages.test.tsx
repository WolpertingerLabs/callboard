// @vitest-environment jsdom
/**
 * A draft keeps the images that were attached when it was saved.
 *
 * "Save as draft" used to take the composer's text and silently drop its
 * attachments, so opening the draft later and sending it produced a different
 * message than sending immediately would have. A draft now uploads its images
 * through the regular upload route and records their ids; opening the draft
 * puts them back in the composer as attachments, so the send that follows is
 * the ordinary one — same upload, same request — that an immediate send makes.
 *
 * Opening a draft restores its images asynchronously, and until that settles
 * the composer holds none of them. Send and Save are held for that window —
 * the first version let both through, and the server then deleted the files
 * the empty set had "dropped". One image failing to load restores the rest,
 * and the failed one stays on the draft instead of being written out of it.
 *
 * The composer is stubbed down to what this needs: it registers the same
 * setters the real one does, keeps whatever text and images it is handed, and
 * offers "save draft" and "send" with them — honouring `sendBlockedReason`
 * the way the real one does. The DraftModal is real.
 */
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Chat from "./Chat";

vi.mock("../components/PromptInput", () => {
  function PromptInputStub({
    onSend,
    sendBlockedReason,
    onSaveDraft,
    onSetValue,
    onAddImages,
  }: {
    onSend: (prompt: string, images?: File[]) => void;
    sendBlockedReason?: string;
    onSaveDraft?: (prompt: string, images?: File[], onSuccess?: () => void) => void;
    onSetValue?: (setter: (value: string | ((current: string) => string)) => void) => void;
    onAddImages?: (add: (files: File[]) => void) => void;
  }) {
    const [text, setText] = useState("look at this");
    const [images, setImages] = useState<File[]>([]);
    useEffect(() => {
      onSetValue?.(() => (value: string | ((current: string) => string)) => setText((cur) => (typeof value === "function" ? value(cur) : value)));
    }, [onSetValue]);
    useEffect(() => {
      onAddImages?.(() => (files: File[]) => setImages((prev) => [...prev, ...files]));
    }, [onAddImages]);
    return (
      <>
        <div data-testid="composer-text">{text}</div>
        <div data-testid="composer-images">{images.map((f) => `${f.name}:${f.type}:${f.size}`).join(",")}</div>
        <button type="button" onClick={() => setImages((prev) => [...prev, new File(["png-bytes"], "shot.png", { type: "image/png" })])}>
          attach image
        </button>
        <button type="button" onClick={() => setImages([])}>
          clear images
        </button>
        <button type="button" onClick={() => onSaveDraft?.(text, images.length > 0 ? images : undefined, () => setImages([]))}>
          save draft
        </button>
        <div data-testid="send-blocked">{sendBlockedReason ?? ""}</div>
        <button
          type="button"
          onClick={() => {
            if (sendBlockedReason) return;
            onSend(text, images.length > 0 ? images : undefined);
            setImages([]);
          }}
        >
          send
        </button>
      </>
    );
  }
  return { default: PromptInputStub };
});

const FOLDER = "/tmp/project";
const UPLOADED_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const STORED_ID = "12345678-1234-4234-8234-123456789abc";
const MISSING_ID = "87654321-4321-4321-8321-cba987654321";

/** Set per test: makes `GET /api/images/:id` for the stored image never answer. */
let hangImageFetch = false;
/** Set per test: how many draft writes fail before one succeeds. */
let failingDraftWrites = 0;

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

type Call = { method: string; url: string; body?: unknown };
let calls: Call[] = [];

function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
  calls.push({ method, url, body });

  if (method === "POST" && url.includes("/images/upload")) {
    const files = (init!.body as FormData).getAll("images") as File[];
    return Promise.resolve(jsonResponse({ success: true, images: files.map((f) => ({ id: UPLOADED_ID, originalName: f.name })) }));
  }
  if (method === "GET" && url === `/api/images/${STORED_ID}`) {
    if (hangImageFetch) return new Promise(() => {});
    const blob = new Blob(["stored-png"], { type: "image/png" });
    return Promise.resolve({ ok: true, status: 200, blob: async () => blob } as unknown as Response);
  }
  if (method === "GET" && url === `/api/images/${MISSING_ID}`) {
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: "Image not found" }), text: async () => "Image not found" } as unknown as Response);
  }
  if ((method === "POST" && url.endsWith("/queue")) || (method === "PUT" && url.includes("/queue/"))) {
    if (failingDraftWrites > 0) {
      failingDraftWrites--;
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "disk full" }), text: async () => "disk full" } as unknown as Response);
    }
  }
  if (method === "POST" && url.endsWith("/queue")) return Promise.resolve(jsonResponse({ id: "draft-new", ...(body as object) }));
  if (method === "DELETE" && url.includes("/queue/")) return Promise.resolve(jsonResponse({ ok: true }));
  if (method === "POST" && url.includes("/chats/new/message")) {
    const stream = new ReadableStream({ start: (controller) => controller.close() });
    return Promise.resolve({ ok: true, status: 200, body: stream, json: async () => ({}) } as unknown as Response);
  }
  if (method === "PUT" && url.includes("/queue/")) return Promise.resolve(jsonResponse({ id: "draft-1", ...(body as object) }));

  if (url.includes("/chats/new/info")) return Promise.resolve(jsonResponse({ folder: FOLDER, slash_commands: [], plugins: [] }));
  if (url.includes("/system-info")) return Promise.resolve(jsonResponse({}));
  if (url.includes("/keywords")) return Promise.resolve(jsonResponse({ keywords: [] }));
  if (url.includes("/mcp-tools")) return Promise.resolve(jsonResponse({ tools: [], servers: [] }));

  return Promise.reject(new Error(`unmocked request: ${method} ${url}`));
}

function renderCompose(state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/chat/new", search: `?folder=${encodeURIComponent(FOLDER)}`, state }]}>
      <Routes>
        <Route path="/chat/new" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
}

const draftWrites = () => calls.filter((c) => (c.method === "POST" && c.url.endsWith("/queue")) || (c.method === "PUT" && c.url.includes("/queue/")));

const uploads = () => calls.filter((c) => c.method === "POST" && c.url.includes("/images/upload"));
const sends = () => calls.filter((c) => c.method === "POST" && c.url.includes("/chats/new/message"));
const draftDeletes = () => calls.filter((c) => c.method === "DELETE" && c.url.includes("/queue/"));
/** Lets every already-resolvable promise and the effects it triggers run. */
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

const WITH_STORED = { draft: { id: "draft-1", user_message: "from the draft", images: [{ id: STORED_ID, originalName: "diagram.png" }] } };
const WITH_ONE_MISSING = {
  draft: {
    id: "draft-1",
    user_message: "from the draft",
    images: [
      { id: STORED_ID, originalName: "diagram.png" },
      { id: MISSING_ID, originalName: "gone.png" },
    ],
  },
};

beforeEach(() => {
  calls = [];
  hangImageFetch = false;
  failingDraftWrites = 0;
  vi.stubGlobal("fetch", vi.fn(fakeServer));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("draft images", () => {
  it("uploads the attached images and saves their ids with the draft", async () => {
    renderCompose();
    fireEvent.click(await screen.findByText("attach image"));
    fireEvent.click(screen.getByText("save draft"));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Save Draft" }));
    });

    await waitFor(() => expect(draftWrites()).toHaveLength(1));
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/images/upload"))).toBe(true);
    expect(draftWrites()[0].body).toMatchObject({ user_message: "look at this", folder: FOLDER, images: [{ id: UPLOADED_ID, originalName: "shot.png" }] });
  });

  it("puts a draft's images back in the composer when the draft is opened", async () => {
    renderCompose({ draft: { id: "draft-1", user_message: "from the draft", images: [{ id: STORED_ID, originalName: "diagram.png" }] } });

    await waitFor(() => expect(screen.getByTestId("composer-text").textContent).toBe("from the draft"));
    await waitFor(() => expect(screen.getByTestId("composer-images").textContent).toBe(`diagram.png:image/png:${"stored-png".length}`));
  });

  it("re-saving an opened draft keeps its restored images by id, uploading only new ones", async () => {
    renderCompose(WITH_STORED);
    await waitFor(() => expect(screen.getByTestId("composer-images").textContent).toContain("diagram.png"));
    fireEvent.click(screen.getByText("attach image"));

    fireEvent.click(screen.getByText("save draft"));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Update Draft" }));
    });

    await waitFor(() => expect(draftWrites()).toHaveLength(1));
    expect(draftWrites()[0]).toMatchObject({
      method: "PUT",
      body: {
        user_message: "from the draft",
        images: [
          { id: STORED_ID, originalName: "diagram.png" },
          { id: UPLOADED_ID, originalName: "shot.png" },
        ],
      },
    });
    // Only the newly attached one; the restored one is not a second copy.
    expect(uploads()).toHaveLength(1);
    expect((uploads()[0].body as FormData).getAll("images").map((f) => (f as File).name)).toEqual(["shot.png"]);
  });

  it("re-saving an opened draft with every image removed clears them", async () => {
    renderCompose({ draft: { id: "draft-1", user_message: "from the draft", images: [{ id: STORED_ID, originalName: "diagram.png" }] } });
    await waitFor(() => expect(screen.getByTestId("composer-images").textContent).toContain("diagram.png"));
    fireEvent.click(screen.getByText("clear images"));
    fireEvent.click(screen.getByText("save draft"));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Update Draft" }));
    });

    await waitFor(() => expect(draftWrites()).toHaveLength(1));
    expect(draftWrites()[0].body).toEqual({ user_message: "from the draft", images: [] });
  });

  it("opens a draft saved before drafts had images, text only", async () => {
    renderCompose({ draft: { id: "draft-1", user_message: "old draft" } });

    await waitFor(() => expect(screen.getByTestId("composer-text").textContent).toBe("old draft"));
    expect(screen.getByTestId("composer-images").textContent).toBe("");
    expect(calls.some((c) => c.url.startsWith("/api/images/"))).toBe(false);
  });

  it("holds Save while the draft's images are still loading, so the draft is not written without them", async () => {
    hangImageFetch = true;
    renderCompose(WITH_STORED);
    await waitFor(() => expect(screen.getByTestId("composer-text").textContent).toBe("from the draft"));

    fireEvent.click(screen.getByText("save draft"));
    await flush();
    // What the first version did here: opened the modal, and Update Draft
    // sent `images: []`, which the server took as "the user removed them".
    const update = screen.queryByRole("button", { name: "Update Draft" });
    if (update) {
      await act(async () => {
        fireEvent.click(update);
      });
      await flush();
    }

    expect(draftWrites()).toEqual([]);
    expect(screen.getByTestId("composer-text").textContent).toBe("from the draft");
    expect(screen.getByRole("status").textContent).toMatch(/restoring this draft's images/i);
  });

  it("holds Send while the draft's images are still loading, and does not delete the draft", async () => {
    hangImageFetch = true;
    renderCompose(WITH_STORED);
    await waitFor(() => expect(screen.getByTestId("composer-text").textContent).toBe("from the draft"));

    fireEvent.click(screen.getByText("send"));
    await flush();

    expect(sends()).toEqual([]);
    expect(draftDeletes()).toEqual([]);
    expect(screen.getByTestId("send-blocked").textContent).toMatch(/restoring this draft's images/i);
  });

  it("restores the images that load when one does not, and a re-save keeps the missing one", async () => {
    renderCompose(WITH_ONE_MISSING);
    await waitFor(() => expect(screen.getByTestId("composer-images").textContent).toBe(`diagram.png:image/png:${"stored-png".length}`));
    await waitFor(() => expect(screen.getByTestId("send-blocked").textContent).toBe(""));

    fireEvent.click(screen.getByText("save draft"));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Update Draft" }));
    });

    await waitFor(() => expect(draftWrites()).toHaveLength(1));
    expect(draftWrites()[0].body).toEqual({
      user_message: "from the draft",
      images: [
        { id: STORED_ID, originalName: "diagram.png" },
        { id: MISSING_ID, originalName: "gone.png" },
      ],
    });
    expect(uploads()).toEqual([]);
  });

  it("sending a draft whose images did not all restore keeps the draft", async () => {
    renderCompose(WITH_ONE_MISSING);
    await waitFor(() => expect(screen.getByTestId("composer-images").textContent).toContain("diagram.png"));
    await waitFor(() => expect(screen.getByTestId("send-blocked").textContent).toBe(""));

    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(sends()).toHaveLength(1));
    await flush();

    expect(draftDeletes()).toEqual([]);
  });

  it("sending a fully restored draft sends its images and deletes the draft", async () => {
    renderCompose(WITH_STORED);
    await waitFor(() => expect(screen.getByTestId("composer-images").textContent).toContain("diagram.png"));
    await waitFor(() => expect(screen.getByTestId("send-blocked").textContent).toBe(""));

    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0].body).toMatchObject({ prompt: "from the draft", imageIds: [UPLOADED_ID] });
    await waitFor(() => expect(draftDeletes().map((c) => c.url)).toEqual(["/api/queue/draft-1"]));
  });

  it("a retry after a failed draft write reuses the upload instead of making another copy", async () => {
    failingDraftWrites = 1;
    renderCompose();
    fireEvent.click(await screen.findByText("attach image"));
    fireEvent.click(screen.getByText("save draft"));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Save Draft" }));
    });
    await screen.findByText(/disk full|failed to save draft/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    });
    await waitFor(() => expect(draftWrites()).toHaveLength(2));
    expect(uploads()).toHaveLength(1);
    expect(draftWrites()[1].body).toMatchObject({ images: [{ id: UPLOADED_ID, originalName: "shot.png" }] });
  });
});
