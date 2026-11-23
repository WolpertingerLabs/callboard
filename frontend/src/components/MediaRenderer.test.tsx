import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import MediaRenderer, { type RenderFileData } from "./MediaRenderer";

afterEach(cleanup);

function fileData(overrides: Partial<RenderFileData> = {}): RenderFileData {
  return {
    type: "render_file",
    file_path: "/home/u/out/report final.zip",
    media_type: "file",
    mime_type: "application/zip",
    display_mode: "inline",
    file_size: 3 * 1024 * 1024,
    ...overrides,
  };
}

const DOWNLOAD_HREF = `/api/files/serve?path=${encodeURIComponent("/home/u/out/report final.zip")}&download=1`;

describe("MediaRenderer: file card", () => {
  it("shows name, size, type and a Download link with download=1, and no preview", () => {
    const { container } = render(<MediaRenderer data={fileData({ caption: "The build output" })} />);
    expect(screen.getByText("report final.zip")).toBeTruthy();
    expect(screen.getByText("3.0 MB · application/zip")).toBeTruthy();
    expect(screen.getByText("The build output")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Download" });
    expect(link.getAttribute("href")).toBe(DOWNLOAD_HREF);
    expect(link.getAttribute("download")).toBe("report final.zip");
    expect(container.querySelector("img, video, audio, iframe")).toBeNull();
    expect(screen.queryByTitle("Fullscreen")).toBeNull();
  });

  it("display_mode fullscreen still draws only the card", () => {
    render(<MediaRenderer data={fileData({ display_mode: "fullscreen" })} />);
    expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the untrusted gate hides the card until View anyway", () => {
    render(<MediaRenderer data={fileData({ untrusted: true, untrusted_reason: "From a scraped page" })} />);
    expect(screen.getByText("From a scraped page")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View anyway" }));
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(DOWNLOAD_HREF);
  });
});

describe("MediaRenderer: download button on media", () => {
  it("a local media file gets a download link", () => {
    render(<MediaRenderer data={fileData({ media_type: "video", mime_type: "video/mp4", file_path: "/tmp/clip.mp4" })} />);
    expect(screen.getByRole("link", { name: "Download clip.mp4" }).getAttribute("href")).toBe(
      `/api/files/serve?path=${encodeURIComponent("/tmp/clip.mp4")}&download=1`,
    );
  });

  it("a URL has none (download=1 never proxies)", () => {
    render(<MediaRenderer data={fileData({ media_type: "image", mime_type: "image/png", file_path: undefined, url: "https://example.com/a.png" })} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
