import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImageThumbnails } from "./MessageBubble";

afterEach(cleanup);

describe("ImageThumbnails", () => {
  it("opens the viewer at the clicked image and navigates between the message's images", () => {
    render(<ImageThumbnails imageIds={["one", "two", "three"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Open image 2 of 3" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("2 / 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next item" }));
    expect(screen.getByText("3 / 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close viewer" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a single image opens without navigation", () => {
    render(<ImageThumbnails imageIds={["solo"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Open image" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next item" })).toBeNull();
  });
});
