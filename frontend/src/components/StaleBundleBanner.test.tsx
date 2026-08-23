// @vitest-environment jsdom
/**
 * The prompt itself: what it offers, and — mostly — what it refuses to do.
 *
 * The single most important assertion in this file is that `location.reload`
 * is never called except from a click. #367's tests pin that a half-typed
 * composer message survives a sidebar crash; a reload prompt that reloaded on
 * its own would discard the same draft, which would make this feature a
 * regression against the thing it was built to help. So the spy is asserted on
 * in every test, not only in the one named for it.
 *
 * The banner reads `staleBuildId` off `SessionContext`, so these tests provide
 * the context directly rather than standing up the poll. The poll's own path is
 * covered in `contexts/SessionContext.staleBundle.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import StaleBundleBanner from "./StaleBundleBanner";
import { SessionContext } from "../contexts/SessionContext";
import { saveDismissedStaleBuildId } from "../utils/localStorage";

const V2 = "1.0.0-alpha.50+gbbbbbbbbbbbb";
const V3 = "1.0.0-alpha.51+gcccccccccccc";

const reload = vi.fn();

beforeEach(() => {
  localStorage.clear();
  reload.mockClear();
  // jsdom's `location.reload` is not configurable in place; replacing the whole
  // object is the supported way to observe it.
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
});

afterEach(() => {
  cleanup();
  // Nothing in this suite may have reloaded the page by itself.
  expect(reload).not.toHaveBeenCalled();
});

function renderBanner(staleBuildId: string | null) {
  return render(
    <SessionContext.Provider value={{ activeSessions: new Map(), connected: true, metadataVersion: 0, summonedChatIds: new Set(), staleBuildId }}>
      <StaleBundleBanner />
    </SessionContext.Provider>,
  );
}

describe("when the daemon has not moved", () => {
  it("renders nothing at all", () => {
    renderBanner(null);
    expect(screen.queryByTestId("stale-bundle-banner")).toBeNull();
  });
});

describe("when the daemon has moved", () => {
  it("says what happened and offers a reload", () => {
    renderBanner(V2);
    expect(screen.getByTestId("stale-bundle-banner")).toBeTruthy();
    expect(screen.getByText("Callboard changed on the server")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("does not claim a direction the daemon may not have moved in", () => {
    // The daemon can be rolled back, and the prompt is still correct then — the
    // tab no longer matches, and reloading still fixes it. "Updated" would be
    // the one word in the copy that is simply false in that case.
    renderBanner(V2);
    const text = screen.getByTestId("stale-bundle-banner").textContent ?? "";
    expect(text).not.toMatch(/updated|newer|older|upgrade/i);
  });

  it("promises the composer's contents survive the wait", () => {
    // The copy is the mechanism by which "non-blocking" is believable. A user
    // mid-message needs to know ignoring this costs them nothing.
    renderBanner(V2);
    expect(screen.getByText(/anything you.{0,3}ve typed stays put/)).toBeTruthy();
  });

  it("announces politely rather than interrupting", () => {
    renderBanner(V2);
    const banner = screen.getByTestId("stale-bundle-banner");
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.getAttribute("aria-live")).toBe("polite");
  });

  it("does not take focus", () => {
    // Stealing the caret out of a textarea mid-sentence is the loudest way a
    // "non-blocking" notice can block.
    renderBanner(V2);
    expect(document.activeElement).toBe(document.body);
  });

  it("reloads only when the button is clicked", () => {
    renderBanner(V2);
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockClear(); // so the afterEach guard still means something
  });
});

describe("dismissal", () => {
  it("hides on 'Not now' and remembers which build that was", () => {
    renderBanner(V2);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(screen.queryByTestId("stale-bundle-banner")).toBeNull();
    expect(JSON.parse(localStorage.getItem("claude-code-settings")!).dismissedStaleBuildId).toBe(V2);
  });

  it("hides on the close control too", () => {
    renderBanner(V2);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(screen.queryByTestId("stale-bundle-banner")).toBeNull();
  });

  it("stays dismissed for that build across a re-mount", () => {
    // A route change re-mounts nothing here, but a second tab on the same
    // origin reads the same store, and neither should re-ask.
    renderBanner(V2);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    cleanup();

    renderBanner(V2);
    expect(screen.queryByTestId("stale-bundle-banner")).toBeNull();
  });

  it("follows a dismissal made in another tab", () => {
    // An upgrade puts this banner up in *every* open tab at once, and those
    // tabs have already mounted — they read the store once and would never see
    // a later write. Without the `storage` listener the user pays one click per
    // tab, which is the shape of nagging the build-id keying exists to avoid.
    renderBanner(V2);
    expect(screen.getByTestId("stale-bundle-banner")).toBeTruthy();

    // What the browser does when the other tab clicks "Not now": the store is
    // already written by the time the event lands.
    saveDismissedStaleBuildId(V2);
    fireEvent(window, new StorageEvent("storage", { key: "claude-code-settings" }));

    expect(screen.queryByTestId("stale-bundle-banner")).toBeNull();
  });

  it("is not silenced by another tab dismissing a different build", () => {
    // The listener re-reads the store; it must not degrade into "any storage
    // write hides the banner".
    renderBanner(V3);
    saveDismissedStaleBuildId(V2);
    fireEvent(window, new StorageEvent("storage", { key: "claude-code-settings" }));

    expect(screen.getByTestId("stale-bundle-banner")).toBeTruthy();
  });

  it("comes back when the daemon moves again", () => {
    renderBanner(V2);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    cleanup();

    renderBanner(V3);
    expect(screen.getByTestId("stale-bundle-banner")).toBeTruthy();
  });
});

describe("theming", () => {
  it("paints from CSS variables only", () => {
    // Enforced here as well as by review: every colour on this banner has to
    // move with a custom theme, and an inline hex would silently not.
    const { container } = renderBanner(V2);
    const styled = container.querySelectorAll<HTMLElement>("[style]");
    expect(styled.length).toBeGreaterThan(0);
    for (const el of styled) {
      const style = el.getAttribute("style") ?? "";
      for (const prop of ["color", "background", "background-color", "border", "border-color", "box-shadow"]) {
        const declared = style.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`));
        if (!declared) continue;
        const value = declared[1].trim();
        if (value === "none" || value === "transparent") continue;
        expect(value, `${prop}: ${value}`).toContain("var(--");
      }
    }
  });
});
