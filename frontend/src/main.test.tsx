// @vitest-environment jsdom
/**
 * The wiring, not the component.
 *
 * `ErrorBoundary.test.tsx` proves the boundary works and `SplitLayout`'s tests
 * prove the region seams are where they should be — but the root backstop lived
 * only in `main.tsx`, which nothing imported, so deleting it left a green suite.
 * That is the one boundary whose absence produces the exact symptom this whole
 * change exists to kill: `root html length: 0`.
 *
 * So this file imports `main.tsx` for real, against a `#root` it puts in the
 * document itself, with `App` mocked to throw the #364 shape on mount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";

vi.mock("./App", () => ({
  default: () => {
    const row = {} as { removability?: { removable: boolean } };
    const { removable } = row.removability as { removable: boolean };
    return <div>{String(removable)}</div>;
  },
}));

let swallow: (e: ErrorEvent) => void;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  swallow = (e: ErrorEvent) => e.preventDefault();
  window.addEventListener("error", swallow);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  window.removeEventListener("error", swallow);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function bootstrap() {
  await act(async () => {
    await import("./main");
  });
  return document.getElementById("root")!;
}

describe("the root backstop", () => {
  it("keeps #root populated when App itself throws", async () => {
    const root = await bootstrap();

    // The number from the #364 review log, which is the whole point.
    expect(root.innerHTML.length).toBeGreaterThan(0);
    expect(root.textContent).toContain("Callboard stopped working");
  });

  it("offers a reload, and no 'Try again' it could not honour", async () => {
    const root = await bootstrap();
    const labels = [...root.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Reload page");
    expect(labels).not.toContain("Try again");
  });
});

describe("global error logging is actually installed", () => {
  it("logs an unhandled rejection once main has run", async () => {
    await bootstrap();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("async blew up") }));

    expect(spy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("Unhandled promise rejection"))).toBe(true);
  });
});
