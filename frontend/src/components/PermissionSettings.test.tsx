import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { normalizePermissions } from "shared/types/permissions.js";
import PermissionSettings from "./PermissionSettings";
import ChatPermissionsModal from "./ChatPermissionsModal";

afterEach(cleanup);
it("renders the fifth permission with the exact boundary note", () => {
  const onChange = vi.fn();
  render(<PermissionSettings permissions={normalizePermissions({ fileRead: "allow" })} onChange={onChange} />);
  const description = screen.getByText(/Controls Callboard's browser and desktop tools\./);
  // Allow is not "no confirmations": it skips only the target-enable step.
  expect(description.textContent).toContain("Allow only skips the confirmation when the agent enables a browser or desktop target");
  expect(description.textContent).toContain("every individual action the agent takes still needs your confirmation");
  expect(description.textContent).toContain("Agents with unrestricted code execution may still run their own automation.");
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
