import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { normalizePermissions } from "shared/types/permissions.js";
import PermissionSettings from "./PermissionSettings";
import ChatPermissionsModal from "./ChatPermissionsModal";

afterEach(cleanup);
it("renders the fifth permission as one line, in the same register as the other four", () => {
  const onChange = vi.fn();
  render(<PermissionSettings permissions={normalizePermissions({ fileRead: "allow" })} onChange={onChange} />);
  // Allow now means allow — the agent acts without a per-action prompt — so the
  // row no longer needs a paragraph explaining away a label that did not match
  // its behaviour. It reads like "Read files, search code, and list
  // directories": what the axis governs, one line, no caveats.
  const description = screen.getByText("Control a managed browser or desktop on the service host");
  expect(description.textContent!.length).toBeLessThan(80);
  expect(description.textContent).not.toMatch(/confirm/i);
  const row = screen.getByText("Browser & Computer Control").parentElement!.parentElement!;
  expect((within(row).getByRole("radio", { name: "Deny" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(row).getByRole("radio", { name: "Ask" }));
  expect(onChange).toHaveBeenCalledWith({ fileRead: "allow", fileWrite: "ask", codeExecution: "ask", webAccess: "ask", computerControl: "ask" });
});
it("enables modal Save for a computer-control-only change", () => {
  render(<ChatPermissionsModal isOpen onClose={() => {}} chatId={undefined} permissions={normalizePermissions(undefined)} onPermissionsChange={() => {}} />);
  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  const row = screen.getByText("Browser & Computer Control").parentElement!.parentElement!;
  fireEvent.click(within(row).getByRole("radio", { name: "Allow" }));
  expect(save.disabled).toBe(false);
});
