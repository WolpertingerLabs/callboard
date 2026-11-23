// @vitest-environment jsdom
/**
 * The docked read-aloud bar (above the composer): when it shows, its close,
 * its controls, labels and keyboard shortcuts, and where focus goes. Driven
 * through the real store (utils/readAloudPlayer.ts) with the server call
 * mocked and jsdom's media stubbed (testing/mediaStubs.ts).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SynthesizedSpeech } from "../api";
import { installMediaStubs, type MediaStubs } from "../testing/mediaStubs";
import { getReadAloudAudioForTesting, getSnapshot, registerSpeaker, resetReadAloudPlayerForTesting, start, stop } from "../utils/readAloudPlayer";
import ReadAloudPlayer, { formatClock } from "./ReadAloudPlayer";

const synth = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ReadAloudRequestError: (await importOriginal<typeof import("../api")>()).ReadAloudRequestError,
  synthesizeSpeech: (...args: unknown[]) => synth.fn(...args),
}));

const speech = (extra: Partial<SynthesizedSpeech> = {}): SynthesizedSpeech => ({
  blob: new Blob(["mp3"]),
  model: "m",
  voice: null,
  truncated: false,
  ...extra,
});

let media: MediaStubs;
beforeEach(() => {
  media = installMediaStubs();
  media.duration = 296;
  synth.fn.mockReset().mockResolvedValue(speech());
  localStorage.clear();
  resetReadAloudPlayerForTesting();
});
afterEach(() => {
  cleanup();
  act(() => resetReadAloudPlayerForTesting());
});

async function playing(owner = "a", extra: Partial<SynthesizedSpeech> = {}, scope?: string) {
  synth.fn.mockResolvedValueOnce(speech(extra));
  await act(async () => {
    start(owner, "Some reply.", scope);
    await new Promise((r) => setTimeout(r, 0));
  });
}

const group = () => screen.getByRole("group", { name: "Read aloud player" });

describe("formatClock", () => {
  it.each([
    [0, "0:00"],
    [5.9, "0:05"],
    [83, "1:23"],
    [3725, "1:02:05"],
    [Number.NaN, "0:00"],
    [Infinity, "0:00"],
    [-4, "0:00"],
  ])("%s → %s", (seconds, text) => {
    expect(formatClock(seconds)).toBe(text);
  });
});

describe("ReadAloudPlayer", () => {
  it("renders nothing while idle", () => {
    const { container } = render(<ReadAloudPlayer />);
    expect(container.innerHTML).toBe("");
  });

  it("appears when a read aloud starts, and goes when it stops", async () => {
    synth.fn.mockReturnValueOnce(new Promise(() => {}));
    render(<ReadAloudPlayer />);
    act(() => start("a", "Text."));
    expect(group()).toBeTruthy();
    act(() => stop());
    expect(screen.queryByRole("group", { name: "Read aloud player" })).toBeNull();
  });

  it("shows only the playback of its own scope", async () => {
    await playing("a", {}, "chat-1");
    const { rerender } = render(<ReadAloudPlayer scope="chat-2" />);
    expect(screen.queryByRole("group", { name: "Read aloud player" })).toBeNull();
    rerender(<ReadAloudPlayer scope="chat-1" />);
    expect(group()).toBeTruthy();
  });

  it("names what it is reading", async () => {
    await playing();
    render(<ReadAloudPlayer />);
    const label = screen.getByText("Some reply.");
    expect(label.closest(".read-aloud-label")?.textContent).toBe("Reading: Some reply.");
    expect(label.closest(".read-aloud-label")?.getAttribute("title")).toBe("Some reply.");
  });

  it("labels every control, with one close and no Stop", async () => {
    await playing();
    render(<ReadAloudPlayer />);
    for (const name of ["Back 10 seconds", "Pause", "Forward 10 seconds", "Close audio player", "Playback speed 1×"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Close audio player" })).toHaveLength(1);
    const seek = screen.getByRole("slider", { name: "Seek" });
    expect(seek.getAttribute("max")).toBe("296");
    expect(seek.getAttribute("aria-valuetext")).toBe("0:00 of 4:56");
    expect(screen.getByText("0:00 / 4:56")).toBeTruthy();
  });

  it("shows elapsed time as it plays", async () => {
    await playing();
    render(<ReadAloudPlayer />);
    const audio = getReadAloudAudioForTesting()!;
    act(() => {
      audio.currentTime = 83;
      audio.dispatchEvent(new Event("timeupdate"));
    });
    expect(screen.getByText("1:23 / 4:56")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Seek" }).getAttribute("aria-valuetext")).toBe("1:23 of 4:56");
  });

  it("drives the store from its buttons", async () => {
    await playing();
    render(<ReadAloudPlayer />);
    const audio = getReadAloudAudioForTesting()!;
    audio.currentTime = 30;
    fireEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
    expect(audio.currentTime).toBe(20);
    fireEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
    expect(audio.currentTime).toBe(30);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(getSnapshot().status).toBe("paused");
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Playback speed 1×" }));
    expect(screen.getByRole("button", { name: "Playback speed 1.25×" }).textContent).toBe("1.25×");
    fireEvent.change(screen.getByRole("slider", { name: "Seek" }), { target: { value: "100" } });
    expect(audio.currentTime).toBe(100);
  });

  it("X closes the whole thing: audio stopped, URL revoked, bar gone", async () => {
    await playing();
    render(<ReadAloudPlayer />);
    fireEvent.click(screen.getByRole("button", { name: "Close audio player" }));
    expect(getSnapshot().status).toBe("idle");
    expect(media.pause).toHaveBeenCalled();
    expect(media.revokeObjectURL).toHaveBeenCalledWith("blob:test/1");
    expect(screen.queryByRole("group", { name: "Read aloud player" })).toBeNull();
  });

  it("X while preparing aborts the synthesis", () => {
    synth.fn.mockReturnValueOnce(new Promise(() => {}));
    act(() => start("a", "Text."));
    render(<ReadAloudPlayer />);
    const signal = synth.fn.mock.calls[0][1] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Close audio player" }));
    expect(signal.aborted).toBe(true);
    expect(getSnapshot().status).toBe("idle");
  });

  it("takes keyboard shortcuts only from inside the player", async () => {
    await playing();
    render(
      <>
        <button>elsewhere</button>
        <ReadAloudPlayer />
      </>,
    );
    const audio = getReadAloudAudioForTesting()!;
    fireEvent.keyDown(screen.getByRole("button", { name: "elsewhere" }), { key: "k" });
    expect(getSnapshot().status).toBe("playing");

    const pause = screen.getByRole("button", { name: "Pause" });
    fireEvent.keyDown(pause, { key: "k" });
    expect(getSnapshot().status).toBe("paused");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "Play" }), { key: " " });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getSnapshot().status).toBe("playing");

    audio.currentTime = 50;
    fireEvent.keyDown(group(), { key: "ArrowLeft" });
    expect(audio.currentTime).toBe(40);
    fireEvent.keyDown(group(), { key: "j" });
    expect(audio.currentTime).toBe(30);
    fireEvent.keyDown(group(), { key: "ArrowRight" });
    expect(audio.currentTime).toBe(40);
    fireEvent.keyDown(group(), { key: "L" });
    expect(audio.currentTime).toBe(50);
    // With a modifier it is someone else's shortcut.
    fireEvent.keyDown(group(), { key: "l", metaKey: true });
    expect(audio.currentTime).toBe(50);
  });

  const space = (el: Element) => {
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    act(() => {
      el.dispatchEvent(event);
    });
    return event;
  };

  it("leaves Space on the other buttons to activate them natively", async () => {
    await playing();
    render(<ReadAloudPlayer />);
    for (const name of ["Close audio player", "Back 10 seconds", "Forward 10 seconds", "Playback speed 1×"]) {
      expect(space(screen.getByRole("button", { name })).defaultPrevented).toBe(false);
      expect(getSnapshot().status).toBe("playing");
    }
  });

  it("takes Space as play/pause on the play button, the slider and the group itself", async () => {
    await playing();
    render(<ReadAloudPlayer />);
    expect(space(screen.getByRole("button", { name: "Pause" })).defaultPrevented).toBe(true);
    expect(getSnapshot().status).toBe("paused");
    await act(async () => {
      space(screen.getByRole("slider", { name: "Seek" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getSnapshot().status).toBe("playing");
    expect(space(group()).defaultPrevented).toBe(true);
    expect(getSnapshot().status).toBe("paused");
  });

  it("leaves Space on Cancel, Retry and Dismiss alone", async () => {
    synth.fn.mockReturnValueOnce(new Promise(() => {}));
    act(() => start("a", "Text."));
    render(<ReadAloudPlayer />);
    expect(space(screen.getByRole("button", { name: "Cancel read aloud" })).defaultPrevented).toBe(false);
    expect(getSnapshot().status).toBe("loading");
  });

  it("leaves arrow keys on the seek slider to the slider", async () => {
    await playing();
    render(<ReadAloudPlayer />);
    const audio = getReadAloudAudioForTesting()!;
    audio.currentTime = 50;
    fireEvent.keyDown(screen.getByRole("slider", { name: "Seek" }), { key: "ArrowLeft" });
    expect(audio.currentTime).toBe(50);
  });

  it("closes on Escape and claims it, so the aside panel and the composer leave it be", async () => {
    await playing();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <ReadAloudPlayer />
      </div>,
    );
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      screen.getByRole("slider", { name: "Seek" }).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(getSnapshot().status).toBe("idle");
    expect(screen.queryByRole("group", { name: "Read aloud player" })).toBeNull();
  });

  it("closes on Escape while preparing, and on an error", async () => {
    synth.fn.mockReturnValueOnce(new Promise(() => {}));
    act(() => start("a", "Text."));
    render(<ReadAloudPlayer />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel read aloud" }), { key: "Escape" });
    expect(getSnapshot().status).toBe("idle");

    synth.fn.mockRejectedValueOnce(new Error("No"));
    await act(async () => {
      start("a", "Text.");
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "Dismiss" }), { key: "Escape" });
    expect(getSnapshot().status).toBe("idle");
  });

  it("says when only the start of a long message is read", async () => {
    await playing("a", { truncated: true });
    render(<ReadAloudPlayer />);
    expect(screen.getByText("Reading the start of this long message.")).toBeTruthy();
  });

  it("shows Preparing with a Cancel while loading", () => {
    synth.fn.mockReturnValueOnce(new Promise(() => {}));
    act(() => start("a", "Text."));
    render(<ReadAloudPlayer />);
    expect(screen.getByText("Preparing audio…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel read aloud" }));
    expect(getSnapshot().status).toBe("idle");
  });

  it("shows an error with Retry and Dismiss", async () => {
    synth.fn.mockRejectedValueOnce(new Error("Upstream said no"));
    await act(async () => {
      start("a", "Text.");
      await new Promise((r) => setTimeout(r, 0));
    });
    render(<ReadAloudPlayer />);
    expect(screen.getByRole("alert").textContent).toContain("Upstream said no");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getSnapshot().status).toBe("playing");
    act(() => resetReadAloudPlayerForTesting());

    synth.fn.mockRejectedValueOnce(new Error("Again"));
    await act(async () => {
      start("a", "Text.");
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(getSnapshot().status).toBe("idle");
  });

  it("offers no Retry for a message with nothing to read", () => {
    act(() => start("a", "```\ncode\n```"));
    render(<ReadAloudPlayer />);
    expect(screen.getByRole("alert").textContent).toContain("only code");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows the tap-to-play hint when autoplay was refused", async () => {
    media.play.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    await playing();
    render(<ReadAloudPlayer />);
    expect(screen.getByText("Tap play to listen.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  describe("focus", () => {
    /** A stand-in for bubble "a"'s speaker, registered as a real one is. */
    function Harness({ speaker = true }: { speaker?: boolean }) {
      const speakerRef = useRef<HTMLButtonElement>(null);
      useEffect(() => (speaker && speakerRef.current ? registerSpeaker("a", speakerRef.current) : undefined), [speaker]);
      return (
        <>
          {speaker && <button ref={speakerRef}>speaker</button>}
          <button>elsewhere</button>
          <ReadAloudPlayer />
        </>
      );
    }

    it("moves focus from Cancel to play/pause when the audio is ready", async () => {
      const d: { resolve?: (v: SynthesizedSpeech) => void } = {};
      synth.fn.mockReturnValueOnce(new Promise<SynthesizedSpeech>((r) => (d.resolve = r)));
      act(() => start("a", "Text."));
      render(<Harness />);
      screen.getByRole("button", { name: "Cancel read aloud" }).focus();
      await act(async () => {
        d.resolve!(speech());
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Pause" }));
    });

    it("does not steal focus that moved elsewhere while loading", async () => {
      const d: { resolve?: (v: SynthesizedSpeech) => void } = {};
      synth.fn.mockReturnValueOnce(new Promise<SynthesizedSpeech>((r) => (d.resolve = r)));
      act(() => start("a", "Text."));
      render(<Harness />);
      screen.getByRole("button", { name: "Cancel read aloud" }).focus();
      screen.getByRole("button", { name: "speaker" }).focus();
      await act(async () => {
        d.resolve!(speech());
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "speaker" }));
    });

    it.each([
      ["Close audio player", (el: HTMLElement) => fireEvent.click(el)],
      ["Pause", (el: HTMLElement) => fireEvent.keyDown(el, { key: "Escape" })],
    ])("returns focus to the speaker when %s ends playback", async (name, act_) => {
      await playing();
      render(<Harness />);
      const el = screen.getByRole("button", { name });
      el.focus();
      act(() => act_(el));
      expect(getSnapshot().status).toBe("idle");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "speaker" }));
    });

    it("returns focus to the speaker on Dismiss and on Cancel", async () => {
      synth.fn.mockRejectedValueOnce(new Error("No"));
      await act(async () => {
        start("a", "Text.");
        await new Promise((r) => setTimeout(r, 0));
      });
      render(<Harness />);
      const dismiss = screen.getByRole("button", { name: "Dismiss" });
      dismiss.focus();
      act(() => fireEvent.click(dismiss));
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "speaker" }));

      synth.fn.mockReturnValueOnce(new Promise(() => {}));
      act(() => start("a", "Text."));
      const cancel = screen.getByRole("button", { name: "Cancel read aloud" });
      cancel.focus();
      act(() => fireEvent.click(cancel));
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "speaker" }));
    });

    it("leaves focus alone when the close came without focus in the bar", async () => {
      await playing();
      render(<Harness />);
      const elsewhere = screen.getByRole("button", { name: "elsewhere" });
      elsewhere.focus();
      // A pointer click that does not move focus (Safari, or a touch).
      act(() => fireEvent.click(screen.getByRole("button", { name: "Close audio player" })));
      expect(document.activeElement).toBe(elsewhere);
    });

    it("does not move focus when the speaker is gone", async () => {
      await playing();
      render(<Harness speaker={false} />);
      const close = screen.getByRole("button", { name: "Close audio player" });
      close.focus();
      act(() => fireEvent.click(close));
      expect(getSnapshot().status).toBe("idle");
      expect(screen.queryByRole("button", { name: "speaker" })).toBeNull();
    });
  });
});
