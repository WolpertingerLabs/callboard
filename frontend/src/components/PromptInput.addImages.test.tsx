// @vitest-environment jsdom
/**
 * Opening a saved draft hands its images back to the composer through
 * `onAddImages`. The Chat-level draft tests stub PromptInput out, so this is
 * the one place the real composer's half of that is pinned: the images it is
 * handed show up as attachments and go out with the next send. If they didn't,
 * Chat would count the restore as done while the composer held nothing, and
 * the send would go out without them and retire the draft.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import PromptInput from "./PromptInput";

vi.mock("../api", () => ({ getSlashCommandContent: vi.fn() }));

beforeEach(() => {
  // jsdom has no object URLs; the attachment thumbnails ask for one each.
  URL.createObjectURL = vi.fn(() => "blob:thumb");
  URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

describe("PromptInput onAddImages", () => {
  it("attaches the images it is handed, and sends them with the message", () => {
    const onSend = vi.fn();
    let addImages: ((files: File[]) => void) | null = null;
    // Registered the way Chat receives it — through a state setter, so what
    // arrives is an updater returning the add function, not the function.
    const setAddImages = (updater: unknown) => {
      addImages = (updater as () => (files: File[]) => void)();
    };
    render(<PromptInput onSend={onSend} disabled={false} onAddImages={setAddImages} />);
    expect(addImages).toBeTypeOf("function");

    const restored = [new File(["a"], "diagram.png", { type: "image/png" }), new File(["b"], "chart.png", { type: "image/png" })];
    act(() => addImages!(restored));

    expect(screen.getByText("2 images selected")).toBeTruthy();

    const textarea = screen.getByPlaceholderText("Add a message (optional)...");
    fireEvent.change(textarea, { target: { value: "from the draft" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe("from the draft");
    // The same File objects: Chat maps them back to their stored ids on re-save.
    expect(onSend.mock.calls[0][1]).toEqual(restored);
    expect(onSend.mock.calls[0][1][0]).toBe(restored[0]);
  });
});
