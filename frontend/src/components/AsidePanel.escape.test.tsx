// @vitest-environment jsdom
/**
 * Escape inside the aside panel closes the innermost thing first: the real
 * composer's "More actions" menu and a command chip's popover each claim it
 * (capture phase, preventDefault), so the panel stays open; the next Escape
 * closes the panel.
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AsidePanel from "./AsidePanel";
import PromptInput from "./PromptInput";
import CommandChip from "./CommandChip";

vi.mock("../api", () => ({
  getSlashCommandContent: vi.fn(async (name: string) => ({ name, source: "custom-skill", description: "", content: "The body." })),
}));

afterEach(cleanup);

it("leaves the panel open when Escape closes the composer's menu", () => {
  const onClose = vi.fn();
  render(
    <AsidePanel label="Aside" isMobile={false} onClose={onClose}>
      <PromptInput onSend={vi.fn()} disabled={false} chatId="aside-1" menuItems={[{ key: "model", icon: null, label: "Model", onClick: vi.fn() }]} />
    </AsidePanel>,
  );
  fireEvent.click(screen.getByTitle("More actions"));
  expect(screen.getByText("Model")).toBeTruthy();

  fireEvent.keyDown(screen.getByText("Model"), { key: "Escape" });
  expect(screen.queryByText("Model")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.keyDown(screen.getByPlaceholderText("Send a message..."), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("leaves the panel open when Escape closes a command chip's popover", async () => {
  const onClose = vi.fn();
  render(
    <AsidePanel label="Aside" isMobile={false} onClose={onClose}>
      <CommandChip name="callboard:foo" chatId="aside-1" onRemove={vi.fn()} />
    </AsidePanel>,
  );
  fireEvent.click(screen.getByRole("button", { name: "/callboard:foo" }));
  await screen.findByText("The body.");

  fireEvent.keyDown(screen.getByText("The body."), { key: "Escape" });
  expect(screen.queryByText("The body.")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

it("lets an Escape pressed in the panel close the panel while the MAIN chat's composer menu is open", () => {
  const onClose = vi.fn();
  render(
    <div className="chat-page">
      <div className="chat-layout" data-testid="main">
        <PromptInput onSend={vi.fn()} disabled={false} chatId="main" menuItems={[{ key: "model", icon: null, label: "Main model", onClick: vi.fn() }]} />
      </div>
      <AsidePanel label="Aside" isMobile={false} onClose={onClose}>
        <div className="chat-layout">
          <textarea aria-label="aside composer" />
        </div>
      </AsidePanel>
    </div>,
  );
  fireEvent.click(screen.getByTitle("More actions"));
  expect(screen.getByText("Main model")).toBeTruthy();

  // Escape in the panel is the panel's: the main chat's menu does not claim it.
  fireEvent.keyDown(screen.getByLabelText("aside composer"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Main model")).toBeTruthy();

  // Escape in the main chat still closes its menu.
  fireEvent.keyDown(screen.getByPlaceholderText("Send a message..."), { key: "Escape" });
  expect(screen.queryByText("Main model")).toBeNull();
});

it("lets an Escape pressed in the panel close the panel while a command chip's popover is open in the main chat", async () => {
  const onClose = vi.fn();
  render(
    <div className="chat-page">
      <div className="chat-layout">
        <CommandChip name="callboard:foo" chatId="main" onRemove={vi.fn()} />
      </div>
      <AsidePanel label="Aside" isMobile={false} onClose={onClose}>
        <div className="chat-layout">
          <textarea aria-label="aside composer" />
        </div>
      </AsidePanel>
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "/callboard:foo" }));
  await screen.findByText("The body.");
  fireEvent.keyDown(screen.getByLabelText("aside composer"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.getByText("The body.")).toBeTruthy();
});
