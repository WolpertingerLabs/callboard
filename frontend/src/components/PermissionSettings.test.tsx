import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { normalizePermissions } from "shared/types/permissions.js";
import PermissionSettings from "./PermissionSettings";
import ChatPermissionsModal from "./ChatPermissionsModal";

afterEach(cleanup);
const rowOf = (label: string) => screen.getByText(label).parentElement!.parentElement!;

it("renders Browser Use immediately before Computer Use, each a separate axis defaulting to deny", () => {
  const onChange = vi.fn();
  render(<PermissionSettings permissions={normalizePermissions({ fileRead: "allow" })} onChange={onChange} />);
  const labels = ["Web Access", "Browser Use", "Computer Use"].map((label) => screen.getByText(label));
  // Document order: Web Access → Browser Use → Computer Use, with nothing between the last two.
  expect(labels[0].compareDocumentPosition(labels[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(labels[1].compareDocumentPosition(labels[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(rowOf("Browser Use").nextElementSibling).toBe(rowOf("Computer Use"));
  // What each axis governs and what it depends on, in one line each. Allow
  // means allow, so neither row explains away its levels with confirmation caveats.
  for (const [pattern, dependency] of [
    [/Control a managed Chromium browser on the service host/, /independent of Web Access/],
    [/Control the Linux X11 desktop on the service host/, /every other axis on Allow/],
  ] as const) {
    const description = screen.getByText(pattern).textContent!;
    expect(description).toMatch(dependency);
    expect(description).not.toMatch(/confirm/i);
    expect(description.length).toBeLessThan(140);
  }
  for (const label of ["Browser Use", "Computer Use"])
    expect((within(rowOf(label)).getByRole("radio", { name: "Deny" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(rowOf("Browser Use")).getByRole("radio", { name: "Ask" }));
  expect(onChange).toHaveBeenLastCalledWith({ fileRead: "allow", fileWrite: "ask", codeExecution: "ask", webAccess: "ask", browserControl: "ask", computerControl: "deny" });
  fireEvent.click(within(rowOf("Computer Use")).getByRole("radio", { name: "Ask" }));
  expect(onChange).toHaveBeenLastCalledWith({ fileRead: "allow", fileWrite: "ask", codeExecution: "ask", webAccess: "ask", browserControl: "deny", computerControl: "ask" });
});
it.each(["Browser Use", "Computer Use"])("enables modal Save for a %s-only change", (label) => {
  render(<ChatPermissionsModal isOpen onClose={() => {}} chatId={undefined} permissions={normalizePermissions(undefined)} onPermissionsChange={() => {}} />);
  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.click(within(rowOf(label)).getByRole("radio", { name: "Allow" }));
  expect(save.disabled).toBe(false);
});
it("renders the review toggles only when asked, and greys parent-can-answer without a parent", () => {
  const onReview = vi.fn();
  const { rerender } = render(<PermissionSettings permissions={normalizePermissions(undefined)} onChange={() => {}} />);
  expect(screen.queryByTestId("permission-review-settings")).toBeNull();
  rerender(
    <PermissionSettings
      permissions={normalizePermissions(undefined)}
      onChange={() => {}}
      review={{ value: { modelReview: false, parentAnswers: false }, onChange: onReview, parent: { available: false } }}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /Model safety review/ }));
  expect(onReview).toHaveBeenCalledWith({ modelReview: true, parentAnswers: false });
  expect((screen.getByRole("checkbox", { name: /Parent can answer/ }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText("This chat has no parent chat.")).toBeTruthy();
});
it("the chat modal saves the review toggles with the permissions", async () => {
  const api = await import("../api");
  const spy = vi.spyOn(api, "updateChatPermissions").mockResolvedValue({} as never);
  const onReview = vi.fn();
  render(
    <ChatPermissionsModal
      isOpen
      onClose={() => {}}
      chatId="c1"
      permissions={normalizePermissions(undefined)}
      onPermissionsChange={() => {}}
      review={{ modelReview: false, parentAnswers: false }}
      hasParent
      onReviewChange={onReview}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /Parent can answer/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(onReview).toHaveBeenCalledWith({ modelReview: false, parentAnswers: true }));
  // Only the flag this tab changed is sent.
  expect(spy).toHaveBeenCalledWith("c1", expect.anything(), { parentAnswers: true });
  spy.mockRestore();
});
it("a stale tab changing only permissions sends no review flags, so it cannot flip one another tab set", async () => {
  const api = await import("../api");
  const spy = vi.spyOn(api, "updateChatPermissions").mockResolvedValue({} as never);
  // This tab opened when model review was off; another tab has since turned it on server-side.
  render(
    <ChatPermissionsModal
      isOpen
      onClose={() => {}}
      chatId="c1"
      permissions={normalizePermissions(undefined)}
      onPermissionsChange={() => {}}
      review={{ modelReview: false, parentAnswers: false }}
      hasParent
    />,
  );
  const row = screen.getByText("File Read").parentElement!.parentElement!;
  fireEvent.click(within(row).getByRole("radio", { name: "Allow" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(spy).toHaveBeenCalled());
  expect(spy.mock.calls[0][2]).toEqual({});
  spy.mockRestore();
});
