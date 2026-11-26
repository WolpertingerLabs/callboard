// @vitest-environment jsdom
/** The "Output" row on background Bash calls, and that its panel (and polling) exists only while open. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ParsedMessage } from "../api";

const getBackgroundTail = vi.hoisted(() => vi.fn());
vi.mock("../api", async (orig) => {
  const real = await orig<typeof import("../api")>();
  return { ...real, getBackgroundTail };
});
const { default: ToolCallBubble } = await import("./ToolCallBubble");

function bash(command: string): ParsedMessage {
  return {
    role: "assistant",
    type: "tool_use",
    toolName: "Bash",
    toolUseId: "toolu_1",
    content: JSON.stringify({ command }),
    timestamp: new Date().toISOString(),
  };
}
function result(backgroundTaskId?: string): ParsedMessage {
  return { role: "assistant", type: "tool_result", toolUseId: "toolu_1", content: "ok", ...(backgroundTaskId && { backgroundTaskId }) };
}

beforeEach(() => {
  getBackgroundTail.mockReset();
  getBackgroundTail.mockImplementation(async () => ({ toolUseId: "toolu_1", streams: [], defaultStream: null, tail: null }));
});
afterEach(() => cleanup());

describe("ToolCallBubble background output row", () => {
  it("shows Live output for a pending background task, and mounts the panel only when expanded", () => {
    render(<ToolCallBubble toolUse={bash("sleep 60")} toolResult={result("b1")} isRunning={false} backgroundPending chatId="c1" />);
    expect(screen.getByText("Live output")).toBeTruthy();
    expect(screen.queryByTestId("background-tail-panel")).toBeNull();
    expect(getBackgroundTail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Live output"));
    expect(screen.getByTestId("background-tail-panel")).toBeTruthy();
    expect(getBackgroundTail).toHaveBeenCalledWith("c1", "toolu_1", expect.anything());

    fireEvent.click(screen.getByText("Live output"));
    expect(screen.queryByTestId("background-tail-panel")).toBeNull();
  });

  it("shows Output for a finished background task", () => {
    render(<ToolCallBubble toolUse={bash("sleep 60")} toolResult={result("b1")} isRunning={false} chatId="c1" />);
    expect(screen.getByText("Output")).toBeTruthy();
  });

  it("shows the row for a detached command that redirects", () => {
    render(<ToolCallBubble toolUse={bash("nohup rsync -a a/ b/ > r.log 2> r.err &")} toolResult={result()} isRunning={false} chatId="c1" />);
    expect(screen.getByText("Output")).toBeTruthy();
  });

  it("hides the row for plain Bash, and without a chat id", () => {
    const { unmount } = render(<ToolCallBubble toolUse={bash("ls > files.txt")} toolResult={result()} isRunning={false} chatId="c1" />);
    expect(screen.queryByText("Output")).toBeNull();
    unmount();
    render(<ToolCallBubble toolUse={bash("sleep 60")} toolResult={result("b1")} isRunning={false} />);
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("does not toggle the input when the row is clicked", () => {
    render(<ToolCallBubble toolUse={bash("sleep 60")} toolResult={result("b1")} isRunning={false} chatId="c1" />);
    fireEvent.click(screen.getByText("Output"));
    expect(screen.queryByText(/"command"/)).toBeNull();
  });
});
