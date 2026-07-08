// @vitest-environment jsdom
/**
 * Tests for the collapsible key-value JSON views:
 * - JsonTreeView: key rows, inline primitives, multiline-string expansion
 *   with real line breaks, nested-JSON string parsing, large-array capping
 * - JsonContentView: tree/pretty/raw mode cycling, non-JSON fallback
 * - localStorage migration from the old jsonPrettyPrint boolean
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import JsonTreeView from "./JsonTreeView";
import JsonContentView from "./JsonContentView";
import { getJsonViewMode, saveJsonViewMode } from "../utils/localStorage";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("JsonTreeView", () => {
  it("renders keys with inline primitive values", () => {
    render(<JsonTreeView value={{ file_path: "/a/b.ts", count: 3, ok: true, missing: null }} />);
    expect(screen.getByText("file_path")).toBeTruthy();
    expect(screen.getByText("/a/b.ts")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("true")).toBeTruthy();
    expect(screen.getByText("null")).toBeTruthy();
  });

  it("collapses multiline strings to a first-line preview and expands to real line breaks", () => {
    const code = 'function hello() {\n  return "world";\n}';
    render(<JsonTreeView value={{ new_string: code }} />);

    // Collapsed: preview with line count, no <pre> block yet
    const preview = screen.getByText(/function hello\(\) \{/);
    expect(screen.getByText(/3 lines/)).toBeTruthy();
    expect(document.querySelector("pre")).toBeNull();

    // Expanded: full string in a <pre> with actual newlines
    fireEvent.click(preview);
    const pre = document.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre!.textContent).toBe(code);
  });

  it("collapses long single-line strings too", () => {
    const long = "x".repeat(100);
    render(<JsonTreeView value={{ data: long }} />);
    expect(document.querySelector("pre")).toBeNull();
    fireEvent.click(screen.getByText(/^x+…$/));
    expect(document.querySelector("pre")!.textContent).toBe(long);
  });

  it("auto-expands nested objects to depth 1 and collapses deeper levels", () => {
    render(<JsonTreeView value={{ outer: { inner: { deep: "v" } } }} />);
    // depth-1 container "outer" is expanded, so "inner" (depth 2) is visible but collapsed
    expect(screen.getByText("inner")).toBeTruthy();
    expect(screen.queryByText("deep")).toBeNull();
    expect(screen.getByText(/\{…\} 1 key/)).toBeTruthy();

    fireEvent.click(screen.getByText(/\{…\} 1 key/));
    expect(screen.getByText("deep")).toBeTruthy();
    expect(screen.getByText("v")).toBeTruthy();
  });

  it("labels array items by index", () => {
    render(<JsonTreeView value={{ items: ["alpha", "beta"] }} />);
    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
  });

  it("renders empty containers inline", () => {
    render(<JsonTreeView value={{ a: {}, b: [] }} />);
    expect(screen.getByText("{}")).toBeTruthy();
    expect(screen.getByText("[]")).toBeTruthy();
  });

  it("caps large arrays with an explicit show-more expander", () => {
    const big = Array.from({ length: 150 }, (_, i) => i);
    render(<JsonTreeView value={{ nums: big }} />);
    // index labels and values both render, so "99" appears twice
    expect(screen.getAllByText("99").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("149")).toHaveLength(0);
    fireEvent.click(screen.getByText(/show 50 more/));
    expect(screen.getAllByText("149").length).toBeGreaterThan(0);
  });

  it("offers a json toggle for strings that are double-encoded JSON", () => {
    const encoded = JSON.stringify({ nested_key: "nested_value", second: 2 }, null, 2);
    render(<JsonTreeView value={{ payload: encoded }} />);

    fireEvent.click(screen.getByText("payload"));
    // Expanded as text first
    expect(document.querySelector("pre")!.textContent).toBe(encoded);

    fireEvent.click(screen.getByText("json"));
    expect(screen.getByText("nested_key")).toBeTruthy();
    expect(screen.getByText("nested_value")).toBeTruthy();

    fireEvent.click(screen.getByText("text"));
    expect(document.querySelector("pre")!.textContent).toBe(encoded);
  });
});

describe("JsonContentView", () => {
  const EDIT_INPUT = JSON.stringify({
    file_path: "/src/app.ts",
    old_string: "const a = 1;\nconst b = 2;",
    new_string: "const a = 1;\nconst b = 3;",
  });

  it("defaults to the tree view for JSON content", () => {
    render(<JsonContentView content={EDIT_INPUT} />);
    expect(screen.getByText("tree")).toBeTruthy();
    expect(screen.getByText("file_path")).toBeTruthy();
    expect(screen.getByText("/src/app.ts")).toBeTruthy();
  });

  it("cycles tree → pretty → raw → tree and persists the preference", () => {
    render(<JsonContentView content={EDIT_INPUT} />);

    fireEvent.click(screen.getByText("tree"));
    expect(screen.getByText("pretty")).toBeTruthy();
    expect(getJsonViewMode()).toBe("pretty");

    fireEvent.click(screen.getByText("pretty"));
    expect(screen.getByText("raw")).toBeTruthy();
    expect(getJsonViewMode()).toBe("raw");
    // Raw shows the untouched string
    expect(document.querySelector("pre")!.textContent).toBe(EDIT_INPUT);

    fireEvent.click(screen.getByText("raw"));
    expect(screen.getByText("tree")).toBeTruthy();
    expect(getJsonViewMode()).toBe("tree");
  });

  it("renders non-JSON content as a plain <pre> with no toggle", () => {
    render(<JsonContentView content="plain text result" />);
    expect(document.querySelector("pre")!.textContent).toBe("plain text result");
    expect(screen.queryByText("tree")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("respects a persisted raw preference", () => {
    saveJsonViewMode("raw");
    render(<JsonContentView content={EDIT_INPUT} />);
    expect(screen.getByText("raw")).toBeTruthy();
    expect(document.querySelector("pre")!.textContent).toBe(EDIT_INPUT);
  });
});

describe("jsonViewMode migration", () => {
  beforeEach(() => localStorage.clear());

  const SETTINGS_KEY = "claude-code-settings";

  it("defaults to tree with no stored preference", () => {
    expect(getJsonViewMode()).toBe("tree");
  });

  it("migrates jsonPrettyPrint=false to raw", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ jsonPrettyPrint: false }));
    expect(getJsonViewMode()).toBe("raw");
  });

  it("migrates jsonPrettyPrint=true to tree", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ jsonPrettyPrint: true }));
    expect(getJsonViewMode()).toBe("tree");
  });

  it("prefers an explicit jsonViewMode over the legacy boolean", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ jsonPrettyPrint: false, jsonViewMode: "pretty" }));
    expect(getJsonViewMode()).toBe("pretty");
  });
});
