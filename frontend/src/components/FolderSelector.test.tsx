// @vitest-environment jsdom
/**
 * Where the folder browser opens: one level above the folder in the field, or
 * — with the field empty — above the folder picked last time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import FolderSelector from "./FolderSelector";

vi.mock("../api", () => ({
  validatePath: vi.fn(async () => ({ valid: true, exists: true, readable: true, isDirectory: true })),
}));

const browserProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock("./FolderBrowser", () => ({
  default: (props: Record<string, unknown>) => {
    browserProps.last = props;
    return props.isOpen ? <div data-testid="browser" data-initial-path={String(props.initialPath)} /> : null;
  },
}));

afterEach(() => {
  cleanup();
  browserProps.last = null;
});

function openAt(value: string, recentDirectories?: string[]) {
  render(<FolderSelector value={value} onChange={() => {}} recentDirectories={recentDirectories} />);
  fireEvent.click(screen.getByTitle("Browse folders"));
  return screen.getByTestId("browser").getAttribute("data-initial-path");
}

describe("FolderSelector — browser start path", () => {
  it("opens above the most recent folder when the field is empty", () => {
    expect(openAt("", ["/home/me/code/app", "/home/me/other"])).toBe("/home/me/code");
  });

  it("prefers the folder typed in the field over the recent list", () => {
    expect(openAt("/srv/site/", ["/home/me/code/app"])).toBe("/srv");
  });

  it("treats a whitespace-only field as empty", () => {
    expect(openAt("   ", ["/home/me/code/app"])).toBe("/home/me/code");
  });

  it("opens at the root with nothing to go on", () => {
    expect(openAt("")).toBe("/");
    cleanup();
    expect(openAt("", [])).toBe("/");
  });

  it("opens at the root for a relative path", () => {
    expect(openAt("code/app", ["/home/me/code/app"])).toBe("/");
  });

  it("opens at the root for a top-level folder", () => {
    expect(openAt("/srv")).toBe("/");
  });

  it("marks the folder it opened above", () => {
    openAt("", ["/home/me/code/app"]);
    expect(browserProps.last?.focusPath).toBe("/home/me/code/app");
    expect(browserProps.last?.focusKind).toBe("last-used");
    cleanup();
    openAt("/srv/site/", ["/home/me/code/app"]);
    expect(browserProps.last?.focusPath).toBe("/srv/site");
    expect(browserProps.last?.focusKind).toBe("current");
  });

  it("marks nothing when opening at the root for want of a folder", () => {
    openAt("");
    expect(browserProps.last?.focusPath).toBeUndefined();
    cleanup();
    openAt("code/app");
    expect(browserProps.last?.focusPath).toBeUndefined();
    cleanup();
    openAt("/");
    expect(browserProps.last?.focusPath).toBeUndefined();
  });

  it("passes the recent list and remove handler through", () => {
    const onRemove = vi.fn();
    render(<FolderSelector value="" onChange={() => {}} recentDirectories={["/a/b"]} onRemoveRecentDirectory={onRemove} />);
    expect(browserProps.last?.recentDirectories).toEqual(["/a/b"]);
    expect(browserProps.last?.onRemoveRecentDirectory).toBe(onRemove);
  });
});
