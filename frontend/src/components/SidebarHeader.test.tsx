import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import SidebarHeader from "./SidebarHeader";

vi.mock("../api", () => ({
  fetchInstanceName: vi.fn().mockResolvedValue(""),
}));

describe("SidebarHeader", () => {
  it("matches new-chat and sidebar-view sizing to the main-view controls", () => {
    render(
      <MemoryRouter>
        <SidebarHeader viewMode="chats" onToggleNew={() => {}} onViewModeChange={() => {}} />
      </MemoryRouter>,
    );

    const mainViewControls = [screen.getByTitle("Board"), screen.getByTitle("Agents"), screen.getByTitle("Settings")];
    const requestedControls = [screen.getByTitle("New Chat"), screen.getByTitle("Switch to folders view"), screen.getByTitle("Chats view (active)")];
    const mainViewSize = {
      width: mainViewControls[0].style.width,
      height: mainViewControls[0].style.height,
      boxSizing: mainViewControls[0].style.boxSizing,
    };

    // jsdom does not calculate layout dimensions, so compare the explicit CSS
    // footprint that the browser uses rather than restating its pixel value.
    expect(mainViewSize.width).not.toBe("");
    expect(mainViewSize.height).not.toBe("");
    expect(mainViewSize.boxSizing).toBe("border-box");
    for (const button of [...mainViewControls.slice(1), ...requestedControls]) {
      expect({
        width: button.style.width,
        height: button.style.height,
        boxSizing: button.style.boxSizing,
      }).toEqual(mainViewSize);
    }
  });
});
