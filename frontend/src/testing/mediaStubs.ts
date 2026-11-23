import { vi } from "vitest";

/**
 * jsdom has no media pipeline: `play()` logs "not implemented", and
 * `duration`/`currentTime`/`playbackRate` do not behave. This stubs them on
 * `HTMLMediaElement.prototype` — play/pause/load as mocks, the three numbers as
 * plain per-element fields, `duration` from {@link MediaStubs.duration} — plus
 * `URL.createObjectURL`/`revokeObjectURL` handing out `blob:test/<n>`.
 *
 * Call from `beforeEach`; media events are dispatched by hand where a real
 * browser would fire them.
 */
export interface MediaStubs {
  /** What every element's `duration` reads. */
  duration: number;
  play: ReturnType<typeof vi.fn<() => Promise<void>>>;
  pause: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  createObjectURL: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
  revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>;
}

export function installMediaStubs(): MediaStubs {
  let urls = 0;
  const stubs: MediaStubs = {
    duration: 60,
    play: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    pause: vi.fn(),
    load: vi.fn(),
    createObjectURL: vi.fn<(blob: Blob) => string>(() => `blob:test/${++urls}`),
    revokeObjectURL: vi.fn<(url: string) => void>(),
  };
  const fields = new WeakMap<object, Record<string, number>>();
  const field = (name: string, initial: number): PropertyDescriptor => ({
    configurable: true,
    get(this: object) {
      return fields.get(this)?.[name] ?? initial;
    },
    set(this: object, v: number) {
      fields.set(this, { ...(fields.get(this) ?? {}), [name]: v });
    },
  });
  const proto = HTMLMediaElement.prototype;
  Object.defineProperty(proto, "play", { configurable: true, value: stubs.play });
  Object.defineProperty(proto, "pause", { configurable: true, value: stubs.pause });
  Object.defineProperty(proto, "load", { configurable: true, value: stubs.load });
  Object.defineProperty(proto, "duration", { configurable: true, get: () => stubs.duration });
  Object.defineProperty(proto, "currentTime", field("currentTime", 0));
  Object.defineProperty(proto, "playbackRate", field("playbackRate", 1));
  Object.defineProperty(proto, "defaultPlaybackRate", field("defaultPlaybackRate", 1));
  Object.assign(URL, { createObjectURL: stubs.createObjectURL, revokeObjectURL: stubs.revokeObjectURL });
  return stubs;
}
