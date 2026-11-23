// @vitest-environment jsdom
/**
 * The composer's mic: dictation only ever puts text into the composer. It
 * never sends, enqueues, asks an aside or saves a draft on the user's behalf,
 * never replaces what is selected, and a transcript for one chat never lands in
 * another's composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VOICE_NOT_CONFIGURED_MESSAGE } from "shared/types/voice.js";
import PromptInput from "./PromptInput";
import { getComposerDraft } from "../utils/localStorage";

const transcribeAudio = vi.fn();
vi.mock("../api", () => ({
  getSlashCommandContent: vi.fn(),
  transcribeAudio: (...args: unknown[]) => transcribeAudio(...args),
}));

vi.mock("../utils/audioWav", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/audioWav")>();
  return {
    ...actual,
    canConvertAudio: () => true,
    toWav16kMono: async () => ({ wav: new Blob(["wav"], { type: "audio/wav" }), durationMs: 2000, rms: 0.1, peak: 0.5 }),
  };
});

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["chunk"]) });
    this.onstop?.();
  }
}

let tracks: FakeTrack[];
const getUserMedia = vi.fn();

beforeEach(() => {
  localStorage.clear();
  tracks = [new FakeTrack()];
  getUserMedia.mockReset().mockImplementation(async () => ({ getTracks: () => tracks }));
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  transcribeAudio.mockReset().mockResolvedValue({ text: "dictated text", model: "m", durationMs: 1 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const AVAILABLE = { available: true };

function renderComposer(props: Partial<React.ComponentProps<typeof PromptInput>> = {}) {
  const callbacks = {
    onSend: vi.fn(),
    onSendVariant: vi.fn(async () => {}),
    onSaveDraft: vi.fn(),
  };
  const base: React.ComponentProps<typeof PromptInput> = {
    ...callbacks,
    disabled: false,
    draftKey: "chat-a",
    sendVariants: { enqueue: { enabled: true }, aside: { enabled: true } },
    voiceInput: AVAILABLE,
    ...props,
  };
  let current = base;
  const view = render(<PromptInput {...base} />);
  return {
    ...callbacks,
    textarea: () => screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement,
    mic: () => screen.getByTestId("voice-input-button"),
    rerender: (next: Partial<React.ComponentProps<typeof PromptInput>>) => {
      current = { ...current, ...next };
      act(() => view.rerender(<PromptInput {...current} />));
    },
  };
}

function expectNothingSent(c: { onSend: ReturnType<typeof vi.fn>; onSendVariant: ReturnType<typeof vi.fn>; onSaveDraft: ReturnType<typeof vi.fn> }) {
  expect(c.onSend).not.toHaveBeenCalled();
  expect(c.onSendVariant).not.toHaveBeenCalled();
  expect(c.onSaveDraft).not.toHaveBeenCalled();
}

describe("PromptInput voice input", () => {
  it("renders no mic without the voiceInput prop", () => {
    renderComposer({ voiceInput: undefined });
    expect(screen.queryByTestId("voice-input-button")).toBeNull();
    // Nor the extra right padding the mic needs.
    expect(screen.getByPlaceholderText("Send a message...").style.padding).toBe("10px 40px 10px 14px");
  });

  it("without an OpenRouter key: rendered, aria-disabled, tooltip names the key, a click does nothing", () => {
    const { mic } = renderComposer({ voiceInput: { available: false, reason: VOICE_NOT_CONFIGURED_MESSAGE } });
    expect(mic().getAttribute("aria-disabled")).toBe("true");
    expect(mic().getAttribute("title")).toBe(VOICE_NOT_CONFIGURED_MESSAGE);
    expect(mic().getAttribute("title")).toMatch(/OpenRouter API key/);
    // aria-disabled, not disabled: still focusable so the tooltip is reachable.
    expect((mic() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(mic());
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("in an insecure context: aria-disabled with the HTTPS/localhost tooltip", () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    const { mic } = renderComposer();
    expect(mic().getAttribute("aria-disabled")).toBe("true");
    expect(mic().getAttribute("title")).toMatch(/HTTPS or localhost/);
    fireEvent.click(mic());
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("without MediaRecorder: aria-disabled with the HTTPS/localhost tooltip", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const { mic } = renderComposer();
    expect(mic().getAttribute("aria-disabled")).toBe("true");
    expect(mic().getAttribute("title")).toMatch(/HTTPS or localhost/);
  });

  it("is disabled along with the composer", () => {
    const { mic } = renderComposer({ disabled: true });
    expect((mic() as HTMLButtonElement).disabled).toBe(true);
  });

  it("widens the textarea's right padding so text clears both icons", () => {
    const { textarea } = renderComposer();
    expect(textarea().style.padding).toBe("10px 68px 10px 14px");
  });

  it("sits left of the paperclip without overlapping it", () => {
    const { mic } = renderComposer();
    const clip = screen.getByTitle("Attach images or files");
    const clipRight = parseFloat(clip.style.right);
    const clipWidth = parseFloat(clip.style.width);
    expect(parseFloat(mic().style.right)).toBeGreaterThanOrEqual(clipRight + clipWidth);
    // Both inside the field, not next to Send or the send menu.
    expect(mic().closest(".composer-field")).toBe(clip.closest(".composer-field"));
  });

  it("records, then inserts the transcript after the selection — keeping existing text — and sends nothing", async () => {
    const c = renderComposer();
    const ta = c.textarea();
    fireEvent.change(ta, { target: { value: "hello world" } });
    ta.focus();
    ta.setSelectionRange(0, 5); // "hello" selected

    expect(c.mic().getAttribute("aria-label")).toBe("Start voice input");
    expect(c.mic().getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(c.mic()));
    expect(c.mic().getAttribute("aria-pressed")).toBe("true");
    expect(c.mic().getAttribute("aria-label")).toBe("Stop recording and transcribe");
    expect(screen.getByRole("status").textContent).toMatch(/Recording/);
    expect(screen.getByRole("status").textContent).toMatch(/0:00/);
    expect(screen.getByRole("status").textContent).toMatch(/5:00/);

    await act(async () => fireEvent.click(c.mic()));
    await waitFor(() => expect(c.textarea().value).toBe("hello dictated text world"));
    expect(tracks[0].stopped).toBe(true);
    expect(c.mic().getAttribute("aria-pressed")).toBe("false");
    expectNothingSent(c);

    // The inserted text is a draft like any typed text.
    await waitFor(() => expect(getComposerDraft("chat-a")).toBe("hello dictated text world"));
    expectNothingSent(c);
  });

  it("appends at the end when the composer was never focused", async () => {
    const c = renderComposer();
    fireEvent.change(c.textarea(), { target: { value: "first" } });
    c.textarea().blur();
    c.textarea().setSelectionRange(0, 0);
    await act(async () => fireEvent.click(c.mic()));
    await act(async () => fireEvent.click(c.mic()));
    await waitFor(() => expect(c.textarea().value).toBe("first dictated text"));
    expectNothingSent(c);
  });

  it("shows Transcribing… while the upload is out", async () => {
    let resolve!: (v: unknown) => void;
    transcribeAudio.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const c = renderComposer();
    await act(async () => fireEvent.click(c.mic()));
    await act(async () => fireEvent.click(c.mic()));
    expect(screen.getByRole("status").textContent).toMatch(/Transcribing/);
    expect(c.mic().getAttribute("aria-busy")).toBe("true");
    await act(async () => resolve({ text: "ok", model: "m", durationMs: 1 }));
    expect(c.textarea().value).toBe("ok");
    expectNothingSent(c);
  });

  it("Escape in the composer cancels recording, inserts nothing, and is claimed", async () => {
    const c = renderComposer();
    fireEvent.change(c.textarea(), { target: { value: "keep me" } });
    await act(async () => fireEvent.click(c.mic()));
    const notCancelled = fireEvent.keyDown(c.textarea(), { key: "Escape" });
    expect(notCancelled).toBe(false); // preventDefault'd, so the aside panel leaves it alone
    await act(async () => {});
    expect(tracks[0].stopped).toBe(true);
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(c.textarea().value).toBe("keep me");
    expect(c.mic().getAttribute("aria-pressed")).toBe("false");
    expectNothingSent(c);
  });

  it("Escape with the slash menu open closes the menu and leaves the recording running", async () => {
    const c = renderComposer({ slashCommands: ["compact"] });
    await act(async () => fireEvent.click(c.mic()));
    fireEvent.change(c.textarea(), { target: { value: "/com" } });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(c.textarea(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(c.mic().getAttribute("aria-pressed")).toBe("true");
    expect(tracks[0].stopped).toBe(false);
  });

  it("Escape while idle is not claimed", () => {
    const c = renderComposer();
    expect(fireEvent.keyDown(c.textarea(), { key: "Escape" })).toBe(true);
  });

  it("never sends even when the transcript is the whole message and every send variant is on", async () => {
    const c = renderComposer({ sendInterrupts: true });
    await act(async () => fireEvent.click(c.mic()));
    await act(async () => fireEvent.click(c.mic()));
    await waitFor(() => expect(c.textarea().value).toBe("dictated text"));
    // Let any stray follow-up (a timer, a microtask) run before asserting.
    await new Promise((r) => setTimeout(r, 50));
    expectNothingSent(c);
  });

  it("a chat switch mid-transcription drops the transcript instead of landing it in the next chat", async () => {
    let resolve!: (v: unknown) => void;
    transcribeAudio.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const c = renderComposer();
    await act(async () => fireEvent.click(c.mic()));
    await act(async () => fireEvent.click(c.mic()));
    const signal = transcribeAudio.mock.calls[0][1] as AbortSignal;
    c.rerender({ draftKey: "chat-b" });
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ text: "meant for chat a", model: "m", durationMs: 1 }));
    expect(c.textarea().value).toBe("");
    expect(getComposerDraft("chat-b")).toBe("");
    expectNothingSent(c);
  });

  it("shows a server error in the status row", async () => {
    transcribeAudio.mockRejectedValueOnce(new Error("Transcription failed: upstream said no"));
    const c = renderComposer();
    await act(async () => fireEvent.click(c.mic()));
    await act(async () => fireEvent.click(c.mic()));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/upstream said no/));
    expect(c.textarea().value).toBe("");
    expectNothingSent(c);
  });
});
