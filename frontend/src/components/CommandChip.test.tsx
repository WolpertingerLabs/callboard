// @vitest-environment jsdom
/**
 * The chip is the only way to see what a slash command actually does, and it
 * pays for that view lazily: nothing is fetched until the popover is opened,
 * and never twice for the same chip. The other half of what's pinned here is
 * the asymmetry between the ways the popover closes — click-away and Escape
 * close it, and only the X takes the command away with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CommandChip from "./CommandChip";

const getSlashCommandContent = vi.fn();
vi.mock("../api", () => ({ getSlashCommandContent: (...args: unknown[]) => getSlashCommandContent(...args) }));

const SKILL = { name: "callboard:foo", source: "custom-skill", description: "Does the thing", content: "# Foo\n\nThe body of the skill." };

beforeEach(() => {
  getSlashCommandContent.mockReset();
  getSlashCommandContent.mockResolvedValue(SKILL);
});

afterEach(cleanup);

function renderChip(props: Partial<React.ComponentProps<typeof CommandChip>> = {}) {
  const onRemove = vi.fn();
  const onOpenChange = vi.fn();
  const view = render(<CommandChip name="callboard:foo" chatId="chat-1" onRemove={onRemove} onOpenChange={onOpenChange} {...props} />);
  return { ...view, onRemove, onOpenChange, name: (n = "callboard:foo") => screen.getByRole("button", { name: `/${n}` }) };
}

describe("CommandChip", () => {
  it("fetches and shows the command body when the name is clicked", async () => {
    const { name } = renderChip();

    expect(getSlashCommandContent).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Remove")).toBeNull();

    fireEvent.click(name());

    expect(getSlashCommandContent).toHaveBeenCalledWith("callboard:foo", { chatId: "chat-1", folder: undefined, activePlugins: undefined });
    expect(await screen.findByText("The body of the skill.")).toBeTruthy();
    expect(screen.getByText("Does the thing")).toBeTruthy();
  });

  it("scrolls the body rather than growing the popover", async () => {
    const { container, name } = renderChip();

    fireEvent.click(name());
    await screen.findByText("The body of the skill.");

    const scroller = container.querySelector('[style*="overflow-y: auto"]') as HTMLElement;
    expect(scroller).toBeTruthy();
    expect(scroller.style.maxHeight).toBe("280px");
    expect(scroller.textContent).toContain("The body of the skill.");
  });

  it("fetches once — reopening the popover reuses what it already has", async () => {
    const { container, name } = renderChip();

    fireEvent.click(name());
    await screen.findByText("The body of the skill.");

    // Click-away closes without removing the chip.
    fireEvent.click(container.querySelector('[style*="position: fixed"]') as HTMLElement);
    expect(screen.queryByText("The body of the skill.")).toBeNull();
    expect(name()).toBeTruthy();

    fireEvent.click(name());
    expect(await screen.findByText("The body of the skill.")).toBeTruthy();
    expect(getSlashCommandContent).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape without removing the chip", async () => {
    const { onRemove, onOpenChange, name } = renderChip();

    fireEvent.click(name());
    await screen.findByText("The body of the skill.");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByText("The body of the skill.")).toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("removes the chip from the X", async () => {
    const { onRemove, name } = renderChip();

    fireEvent.click(name());
    fireEvent.click(await screen.findByTitle("Remove"));

    expect(onRemove).toHaveBeenCalledTimes(1);
    // The popover closes with the click; the parent is what unmounts the chip.
    expect(screen.queryByText("The body of the skill.")).toBeNull();
  });

  it("shows a built-in's known description and says there is no body", async () => {
    getSlashCommandContent.mockResolvedValue({ name: "compact", source: "builtin", description: null, content: null });
    const { name } = renderChip({ name: "compact" });

    fireEvent.click(name("compact"));

    expect(await screen.findByText("No content available.")).toBeTruthy();
    // Falls back to the built-in description table when the server has none.
    expect(screen.getByText("Switch to compact view mode")).toBeTruthy();
  });

  it("says so when the body cannot be loaded", async () => {
    getSlashCommandContent.mockRejectedValue(new Error("boom"));
    const { name } = renderChip();

    fireEvent.click(name());

    expect(await screen.findByText("Could not load command content.")).toBeTruthy();
  });

  /**
   * The fetch-once latch is about not re-asking for an answer we have — a
   * failure is not an answer. Latching it would mean one dropped request (a
   * daemon restart, a sleeping laptop) blanks that chip until it is removed and
   * re-picked, with the retry the user reaches for doing nothing.
   */
  it("retries after a failure instead of latching it", async () => {
    getSlashCommandContent.mockRejectedValueOnce(new Error("boom"));
    const { container, name } = renderChip();

    fireEvent.click(name());
    await screen.findByText("Could not load command content.");
    fireEvent.click(container.querySelector('[style*="position: fixed"]') as HTMLElement);

    fireEvent.click(name());
    expect(await screen.findByText("The body of the skill.")).toBeTruthy();
    expect(getSlashCommandContent).toHaveBeenCalledTimes(2);
  });

  /**
   * On `/chat/new` there is no chat id at all — and that is where a skill is
   * most often picked. The folder is what the lookup keys on server-side, so a
   * chip with a folder is a chip that works.
   */
  it("resolves against the folder when there is no chat yet", async () => {
    const { name } = renderChip({ chatId: undefined, folder: "/tmp/proj", activePlugins: ["p1"] });

    fireEvent.click(name());

    expect(getSlashCommandContent).toHaveBeenCalledWith("callboard:foo", { chatId: undefined, folder: "/tmp/proj", activePlugins: ["p1"] });
    expect(await screen.findByText("The body of the skill.")).toBeTruthy();
  });

  it("does not fetch at all with neither a chat nor a folder", async () => {
    const { name } = renderChip({ chatId: undefined, description: "Does the thing" });

    fireEvent.click(name());

    await waitFor(() => expect(screen.getByText("No content available.")).toBeTruthy());
    expect(getSlashCommandContent).not.toHaveBeenCalled();
    expect(screen.getByText("Does the thing")).toBeTruthy();
  });
});
