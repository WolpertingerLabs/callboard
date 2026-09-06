import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import MessageBubble from "./MessageBubble";
import { getToolDisplayName, getToolSummary } from "./toolFormatting";

vi.mock("../api", () => ({}));
afterEach(cleanup);

describe("native collaboration rendering", () => {
  it.each([
    ["MESSAGE", "Agent message"],
    ["FINAL_ANSWER", "Agent final result"],
    ["FUTURE", "Agent message (FUTURE)"],
  ])("labels %s without root/user attribution", (kind, label) => {
    render(
      <MessageBubble
        message={{
          role: "system",
          type: "system",
          subtype: "agent_message",
          content: "Readable reply\n\n[Encrypted collaboration content unavailable]",
          collaboration: { author: "/root/example", recipient: "/root", id: "reply-1", kind, encrypted: true },
        }}
        onFork={vi.fn()}
      />,
    );
    expect(screen.getByText(`${label} · /root/example → /root`)).toBeTruthy();
    expect(screen.getByText("Message ID: reply-1")).toBeTruthy();
    expect(screen.getByText("Readable reply")).toBeTruthy();
    expect(screen.getByText("[Encrypted collaboration content unavailable]")).toBeTruthy();
    expect(screen.queryByTitle("Fork conversation from here")).toBeNull();
  });

  it("retains namespace identity and summarizes task/target rather than opaque bodies", () => {
    expect(getToolDisplayName("collaboration.spawn_agent")).toBe("collaboration.spawn_agent");
    expect(
      getToolSummary("collaboration.spawn_agent", JSON.stringify({ task_name: "example", message: "[Encrypted collaboration content unavailable]" })),
    ).toBe(" - example");
    expect(getToolSummary("collaboration.send_message", JSON.stringify({ target: "/root/example", message: "hello" }))).toBe(" - /root/example");
    expect(getToolSummary("ordinary", JSON.stringify({ message: "ordinary message" }))).toBe(" - ordinary message");
  });
});
