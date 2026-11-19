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

type Loc = { key: string; pathname: string; search: string; nav?: "PUSH" | "POP" | "REPLACE"; target?: string | null };

it("keeps the view key across the panel's own navigations and Back/Forward over them, and rotates it on any other", () => {
  const { result, rerender } = renderHook((loc: Loc) => useChatViewKey(loc, loc.nav ?? "PUSH", loc.target ?? null), {
    initialProps: { key: "k1", pathname: "/chat/a", search: "" } as Loc,
  });
  expect(result.current).toBe("k1");
  // The panel opens (announced).
  rerender({ key: "k2", pathname: "/chat/a", search: "?aside=x", target: "?aside=x" });
  expect(result.current).toBe("k1");
  // Back closes it.
  rerender({ key: "k1", pathname: "/chat/a", search: "", nav: "POP" });
  expect(result.current).toBe("k1");
  // Forward reopens it.
  rerender({ key: "k2", pathname: "/chat/a", search: "?aside=x", nav: "POP" });
  expect(result.current).toBe("k1");
  // A sidebar click on the open chat drops the param too, but is not the panel's: a new view.
  rerender({ key: "k5", pathname: "/chat/a", search: "", nav: "PUSH" });
  expect(result.current).toBe("k5");
  // The same URL again (a state-stripping replace) is a new view, as before.
  rerender({ key: "k6", pathname: "/chat/a", search: "", nav: "REPLACE" });
  expect(result.current).toBe("k6");
  // Another chat, even announced, is a new view.
  rerender({ key: "k7", pathname: "/chat/b", search: "?aside=x", target: "?aside=x" });
  expect(result.current).toBe("k7");
});
