// @vitest-environment jsdom
/**
 * The inline read-aloud player: its controls, labels and keyboard shortcuts.
 * Driven through the real store (utils/readAloudPlayer.ts) with the server
 * call mocked and jsdom's media stubbed (testing/mediaStubs.ts).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SynthesizedSpeech } from "../api";
import { installMediaStubs, type MediaStubs } from "../testing/mediaStubs";
import { getReadAloudAudioForTesting, getSnapshot, resetReadAloudPlayerForTesting, start } from "../utils/readAloudPlayer";
import ReadAloudPlayer, { formatClock } from "./ReadAloudPlayer";

const synth = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../api", () => ({ synthesizeSpeech: (...args: unknown[]) => synth.fn(...args) }));

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

async function playing(owner = "a", extra: Partial<SynthesizedSpeech> = {}) {
  synth.fn.mockResolvedValueOnce(speech(extra));
  await act(async () => {
    start(owner, "Some reply.");
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
  it("renders nothing for a bubble that is not playing", async () => {
    await playing("a");
    const { container } = render(<ReadAloudPlayer ownerId="b" />);
    expect(container.innerHTML).toBe("");
  });

  it("labels every control", async () => {
    await playing();
    render(<ReadAloudPlayer ownerId="a" />);
    for (const name of ["Back 10 seconds", "Pause", "Forward 10 seconds", "Stop", "Playback speed 1×"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    const seek = screen.getByRole("slider", { name: "Seek" });
    expect(seek.getAttribute("max")).toBe("296");
    expect(seek.getAttribute("aria-valuetext")).toBe("0:00 of 4:56");
    expect(screen.getByText("0:00 / 4:56")).toBeTruthy();
  });

  it("shows elapsed time as it plays", async () => {
    await playing();
    render(<ReadAloudPlayer ownerId="a" />);
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
    render(<ReadAloudPlayer ownerId="a" />);
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
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(getSnapshot().status).toBe("idle");
  });

  it("takes keyboard shortcuts only from inside the player", async () => {
    await playing();
    render(
      <>
        <button>elsewhere</button>
        <ReadAloudPlayer ownerId="a" />
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

  it("claims Space so it does not also click the focused button", async () => {
    await playing();
    render(<ReadAloudPlayer ownerId="a" />);
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    act(() => {
      screen.getByRole("button", { name: "Stop" }).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(getSnapshot().status).toBe("paused");
  });

  it("leaves arrow keys on the seek slider to the slider", async () => {
    await playing();
    render(<ReadAloudPlayer ownerId="a" />);
    const audio = getReadAloudAudioForTesting()!;
    audio.currentTime = 50;
    fireEvent.keyDown(screen.getByRole("slider", { name: "Seek" }), { key: "ArrowLeft" });
    expect(audio.currentTime).toBe(50);
  });

  it("stops on Escape and claims it, so the aside panel and the composer leave it be", async () => {
    await playing();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <ReadAloudPlayer ownerId="a" />
      </div>,
    );
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      screen.getByRole("slider", { name: "Seek" }).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(getSnapshot().status).toBe("idle");
  });

  it("says when only the start of a long message is read", async () => {
    await playing("a", { truncated: true });
    render(<ReadAloudPlayer ownerId="a" />);
    expect(screen.getByText(/Reading the first ~13 minutes/)).toBeTruthy();
  });

  it("shows Preparing with a Cancel while loading", () => {
    synth.fn.mockReturnValueOnce(new Promise(() => {}));
    act(() => start("a", "Text."));
    render(<ReadAloudPlayer ownerId="a" />);
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
    render(<ReadAloudPlayer ownerId="a" />);
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
    render(<ReadAloudPlayer ownerId="a" />);
    expect(screen.getByRole("alert").textContent).toContain("only code");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows the tap-to-play hint when autoplay was refused", async () => {
    media.play.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    await playing();
    render(<ReadAloudPlayer ownerId="a" />);
    expect(screen.getByText("Tap play to listen.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });
});
