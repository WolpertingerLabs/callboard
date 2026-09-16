// @vitest-environment jsdom
/**
 * The drawer's whole contract is "peek, then hand off to the browser modal" —
 * so the hand-off has to be reachable, and the peek has to admit it is one.
 *
 * It was neither. With 82 MCP tools the panel rendered all of them inside a
 * 220px scroll box whose only exit — the "Open tool browser" button — was the
 * last child *of that box*, measured 1442px below the fold behind a 2px overlay
 * scrollbar. Nothing on screen said the list continued, and in practice nothing
 * got the user to the modal.
 *
 * The Commands section was fine only because one install happened to have four
 * commands, which is not a property of the code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SessionInfoNav from "./SessionInfoNav";
import type { McpToolsResponse } from "../api";

const tools = (n: number): McpToolsResponse => ({
  servers: [],
  tools: Array.from({ length: n }, (_, i) => ({
    name: `tool_${i}`,
    qualifiedName: `mcp__demo__tool_${i}`,
    description: "",
    parameters: [],
    serverName: "demo",
    serverLabel: "Demo",
    category: "platform" as const,
  })),
});

const commands = (n: number) => Array.from({ length: n }, (_, i) => `cmd-${i}`);

function renderNav(props: Partial<React.ComponentProps<typeof SessionInfoNav>> = {}) {
  const onInsertPrompt = vi.fn();
  const onOpenModal = vi.fn();
  const view = render(<SessionInfoNav slashCommands={[]} mcpTools={null} onInsertPrompt={onInsertPrompt} onOpenModal={onOpenModal} {...props} />);
  return { ...view, onInsertPrompt, onOpenModal };
}

/** The scrolling region a panel's rows live in, or null if the rows are loose. */
function scrollRegion(panelId: string): HTMLElement | null {
  const panel = document.getElementById(panelId)!;
  return Array.from(panel.children).find((el): el is HTMLElement => (el as HTMLElement).style.overflowY === "auto") ?? null;
}

afterEach(cleanup);

describe("SessionInfoNav — the panel is a peek, not a viewer", () => {
  it("keeps the tool browser link out of the scrolling region", () => {
    const { onOpenModal } = renderNav({ mcpTools: tools(82) });
    fireEvent.click(screen.getByRole("button", { name: /Tools/ }));

    const link = screen.getByRole("button", { name: "Open tool browser" });
    const scroll = scrollRegion("session-info-tools-panel");

    expect(scroll).not.toBeNull();
    expect(scroll!.contains(link)).toBe(false);

    fireEvent.click(link);
    expect(onOpenModal).toHaveBeenCalledWith("tools");
  });

  it("caps the list and names the number it is hiding", () => {
    renderNav({ mcpTools: tools(82) });
    fireEvent.click(screen.getByRole("button", { name: /Tools/ }));

    expect(screen.getByText("Showing 12 of 82")).toBeTruthy();
    expect(screen.getByText("tool_11")).toBeTruthy();
    expect(screen.queryByText("tool_12")).toBeNull();
  });

  it("applies the same rule to Commands rather than trusting the list to be short", () => {
    const { onOpenModal } = renderNav({ slashCommands: commands(40) });
    fireEvent.click(screen.getByRole("button", { name: /Commands/ }));

    expect(screen.getByText("Showing 12 of 40")).toBeTruthy();
    const link = screen.getByRole("button", { name: "Open commands browser" });
    expect(scrollRegion("session-info-commands-panel")!.contains(link)).toBe(false);

    fireEvent.click(link);
    expect(onOpenModal).toHaveBeenCalledWith("commands");
  });

  it("does not claim truncation when nothing is truncated", () => {
    renderNav({ slashCommands: commands(4) });
    fireEvent.click(screen.getByRole("button", { name: /Commands/ }));

    expect(screen.queryByText(/Showing/)).toBeNull();
    expect(screen.getByText("4 total")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open commands browser" })).toBeTruthy();
  });

  it("gives its pills and command chips a thumb-sized tap target", () => {
    // 28px measured on a 390px-wide phone, against the conventional 44px.
    renderNav({ slashCommands: commands(4) });
    const pill = screen.getByRole("button", { name: /Commands/ }) as HTMLButtonElement;
    expect(pill.style.minHeight).toBe("44px");

    fireEvent.click(pill);
    expect((screen.getByRole("button", { name: "cmd-0" }) as HTMLButtonElement).style.minHeight).toBe("44px");
  });

  it("stands its Commands pill down when the launchpad is already showing the grid", () => {
    // Two surfaces for one list, four rows apart, is the duplication this
    // component was added to remove.
    renderNav({ slashCommands: commands(4), mcpTools: tools(3), showCommands: false });

    expect(screen.queryByRole("button", { name: /Commands/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Tools/ })).toBeTruthy();
  });
});
