// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ActiveSearchBar from "./ActiveSearchBar";

afterEach(cleanup);

it("pluralises the count", () => {
  const { rerender } = render(<ActiveSearchBar query="cache" resultCount={1} isSearching={false} onClear={() => {}} inset={20} />);
  expect(screen.getByRole("status").textContent).toBe('Searching for "cache" · 1 chat');
  rerender(<ActiveSearchBar query="cache" resultCount={0} isSearching={false} onClear={() => {}} inset={20} />);
  expect(screen.getByRole("status").textContent).toBe('Searching for "cache" · 0 chats');
  rerender(<ActiveSearchBar query="cache" resultCount={3} isSearching={false} onClear={() => {}} inset={20} />);
  expect(screen.getByRole("status").textContent).toBe('Searching for "cache" · 3 chats');
});

it("shows an ellipsis instead of a count while the request is in flight", () => {
  render(<ActiveSearchBar query="cache" resultCount={3} isSearching onClear={() => {}} inset={20} />);
  expect(screen.getByRole("status").textContent).toBe('Searching for "cache" · …');
});

it("clears through a non-submitting button", () => {
  const onClear = vi.fn();
  render(<ActiveSearchBar query="cache" resultCount={1} isSearching={false} onClear={onClear} inset={20} />);
  const button = screen.getByRole("button", { name: "Clear search" });
  expect(button.getAttribute("type")).toBe("button");
  fireEvent.click(button);
  expect(onClear).toHaveBeenCalledOnce();
});
