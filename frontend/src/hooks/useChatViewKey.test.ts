import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { asideOnlyChange, useChatViewKey } from "./useChatViewKey";

it("asideOnlyChange: the aside param changed and nothing else did", () => {
  expect(asideOnlyChange("", "?aside=a")).toBe(true);
  expect(asideOnlyChange("?aside=a", "?aside=b")).toBe(true);
  expect(asideOnlyChange("?aside=a", "")).toBe(true);
  expect(asideOnlyChange("?x=1&aside=a", "?aside=b&x=1")).toBe(true);
  expect(asideOnlyChange("", "")).toBe(false);
  expect(asideOnlyChange("?aside=a", "?aside=a")).toBe(false);
  expect(asideOnlyChange("?folder=/a", "?folder=/b&aside=x")).toBe(false);
});

it("keeps the view key across the panel opening and closing, and rotates it on any other navigation", () => {
  const { result, rerender } = renderHook((loc: { key: string; pathname: string; search: string }) => useChatViewKey(loc), {
    initialProps: { key: "k1", pathname: "/chat/a", search: "" },
  });
  expect(result.current).toBe("k1");
  rerender({ key: "k2", pathname: "/chat/a", search: "?aside=x" });
  expect(result.current).toBe("k1");
  rerender({ key: "k3", pathname: "/chat/a", search: "" });
  expect(result.current).toBe("k1");
  // The same URL again (a sidebar click, a state-stripping replace) is a new view, as before.
  rerender({ key: "k4", pathname: "/chat/a", search: "" });
  expect(result.current).toBe("k4");
  rerender({ key: "k5", pathname: "/chat/b", search: "?aside=x" });
  expect(result.current).toBe("k5");
});
