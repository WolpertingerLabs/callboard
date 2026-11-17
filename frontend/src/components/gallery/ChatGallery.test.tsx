import { afterEach, describe, expect, it } from "vitest";
import { useRef, useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChatGalleryProvider, sortByDocumentOrder, useGalleryItem } from "./ChatGallery";
import { ImageThumbnails } from "../MessageBubble";
import MediaRenderer, { type RenderFileData } from "../MediaRenderer";

afterEach(cleanup);

const dialog = () => screen.getByRole("dialog", { name: "Image viewer" });
const counter = () => within(dialog()).queryByText(/^\d+ \/ \d+$/)?.textContent ?? null;
/** The image currently shown: the one in the slot that is not aria-hidden. */
const currentSrc = () => dialog().querySelector('[aria-hidden="false"] img')?.getAttribute("src");

function media(overrides: Partial<RenderFileData> = {}): RenderFileData {
  return {
    type: "render_file",
    file_path: "/tmp/chart.png",
    media_type: "image",
    mime_type: "image/png",
    display_mode: "inline",
    file_size: 1234,
    ...overrides,
  };
}

function Chat({ children }: { children: ReactNode }) {
  return <ChatGalleryProvider>{children}</ChatGalleryProvider>;
}

describe("sortByDocumentOrder", () => {
  it("orders entries by their position in the document", () => {
    const root = document.createElement("div");
    const [a, b, c] = ["a", "b", "c"].map((id) => {
      const el = document.createElement("span");
      el.id = id;
      root.appendChild(el);
      return el;
    });
    document.body.appendChild(root);
    try {
      expect(sortByDocumentOrder([{ el: c }, { el: a }, { el: b }]).map((e) => (e.el as HTMLElement).id)).toEqual(["a", "b", "c"]);
    } finally {
      root.remove();
    }
  });
});

describe("ChatGalleryProvider", () => {
  it("swipes across every message's images, in display order", () => {
    render(
      <Chat>
        <ImageThumbnails imageIds={["m1a", "m1b"]} />
        <ImageThumbnails imageIds={["m2a"]} />
      </Chat>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open image 2 of 2" }));
    expect(counter()).toBe("2 / 3");
    expect(currentSrc()).toBe("/api/images/m1b");

    fireEvent.click(within(dialog()).getByRole("button", { name: "Next image" }));
    expect(counter()).toBe("3 / 3");
    expect(currentSrc()).toBe("/api/images/m2a");
  });

  it("orders by DOM position, not by the order images registered in", () => {
    const { rerender } = render(
      <Chat>
        <ImageThumbnails key="later" imageIds={["later"]} />
      </Chat>,
    );
    // Mounted second, but drawn first.
    rerender(
      <Chat>
        <ImageThumbnails key="earlier" imageIds={["earlier"]} />
        <ImageThumbnails key="later" imageIds={["later"]} />
      </Chat>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Open image" })[1]);
    expect(counter()).toBe("2 / 2");
    expect(currentSrc()).toBe("/api/images/later");
  });

  it("drops an image that unmounts", () => {
    const { rerender } = render(
      <Chat>
        <ImageThumbnails key="a" imageIds={["a"]} />
        <ImageThumbnails key="b" imageIds={["b"]} />
      </Chat>,
    );
    rerender(
      <Chat>
        <ImageThumbnails key="b" imageIds={["b"]} />
      </Chat>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open image" }));
    expect(currentSrc()).toBe("/api/images/b");
    expect(within(dialog()).queryByRole("button", { name: "Next image" })).toBeNull();
  });

  it("keeps the open viewer's list fixed while new images arrive", () => {
    const { rerender } = render(
      <Chat>
        <ImageThumbnails key="a" imageIds={["a", "b"]} />
      </Chat>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open image 1 of 2" }));
    expect(counter()).toBe("1 / 2");
    rerender(
      <Chat>
        <ImageThumbnails key="new" imageIds={["new"]} />
        <ImageThumbnails key="a" imageIds={["a", "b"]} />
      </Chat>,
    );
    expect(counter()).toBe("1 / 2");
    expect(currentSrc()).toBe("/api/images/a");
  });

  it("registering images does not re-render other gallery consumers", () => {
    let renders = 0;
    function Consumer() {
      renders++;
      const ref = useRef<HTMLSpanElement>(null);
      useGalleryItem(ref, { src: "/consumer.png", alt: "consumer" });
      return <span ref={ref} />;
    }
    const consumer = <Consumer />;
    // Same child slots in both renders, so the consumer is updated in place
    // rather than remounted.
    const { rerender } = render(
      <Chat>
        {consumer}
        {null}
      </Chat>,
    );
    const before = renders;
    rerender(
      <Chat>
        {consumer}
        <ImageThumbnails imageIds={["x", "y", "z"]} />
      </Chat>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open image 1 of 3" }));
    expect(counter()).toBe("2 / 4");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close image viewer" }));
    expect(renders).toBe(before);
  });

  it("leaves out an image removed in the same commit as the open", () => {
    function Transcript() {
      const [showSibling, setShowSibling] = useState(true);
      return (
        // The tap that opens the viewer also removes the other image, so both
        // land in one commit — before the removed image's unregister runs.
        <div onClick={() => setShowSibling(false)}>
          <ImageThumbnails key="tapped" imageIds={["tapped"]} />
          {showSibling && <ImageThumbnails key="gone" imageIds={["gone"]} />}
        </div>
      );
    }
    render(
      <Chat>
        <Transcript />
      </Chat>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Open image" })[0]);
    expect(currentSrc()).toBe("/api/images/tapped");
    expect(within(dialog()).queryByRole("button", { name: "Next image" })).toBeNull();
  });

  it("closes the viewer when the chat changes", () => {
    const { rerender } = render(
      <ChatGalleryProvider resetKey="chat-b">
        <ImageThumbnails imageIds={["b1", "b2"]} />
      </ChatGalleryProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open image 1 of 2" }));
    expect(counter()).toBe("1 / 2");
    rerender(
      <ChatGalleryProvider resetKey="chat-a">
        <ImageThumbnails imageIds={["a1"]} />
      </ChatGalleryProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the viewer open across re-renders of the same chat", () => {
    const { rerender } = render(
      <ChatGalleryProvider resetKey="chat-b">
        <ImageThumbnails imageIds={["b1", "b2"]} />
      </ChatGalleryProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open image 1 of 2" }));
    rerender(
      <ChatGalleryProvider resetKey="chat-b">
        <ImageThumbnails imageIds={["b1", "b2"]} />
      </ChatGalleryProvider>,
    );
    expect(counter()).toBe("1 / 2");
  });

  it("closes and opens again at a different image", () => {
    render(
      <Chat>
        <ImageThumbnails imageIds={["a", "b", "c"]} />
      </Chat>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open image 3 of 3" }));
    expect(counter()).toBe("3 / 3");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open image 1 of 3" }));
    expect(counter()).toBe("1 / 3");
  });
});

describe("MediaRenderer in the chat gallery", () => {
  function loadMedia() {
    // The fullscreen button appears once the inline media has loaded.
    document.querySelectorAll("img, video").forEach((el) => fireEvent.load(el));
  }

  it("a rendered image joins the gallery alongside attached images", () => {
    render(
      <Chat>
        <ImageThumbnails imageIds={["upload"]} />
        <MediaRenderer data={media({ caption: "Quarterly chart" })} />
      </Chat>,
    );
    loadMedia();
    fireEvent.click(screen.getByTitle("Fullscreen"));
    expect(counter()).toBe("2 / 2");
    expect(within(dialog()).getByText("Quarterly chart")).toBeTruthy();
    expect(currentSrc()).toBe(`/api/files/serve?path=${encodeURIComponent("/tmp/chart.png")}`);

    fireEvent.click(within(dialog()).getByRole("button", { name: "Previous image" }));
    expect(currentSrc()).toBe("/api/images/upload");
  });

  it("tapping the inline image opens the gallery", () => {
    render(
      <Chat>
        <MediaRenderer data={media({ caption: "Tap me" })} />
      </Chat>,
    );
    fireEvent.click(screen.getByAltText("Tap me"));
    expect(dialog()).toBeTruthy();
  });

  it("an untrusted image stays out of the gallery until the user chooses to view it", () => {
    render(
      <Chat>
        <ImageThumbnails imageIds={["upload"]} />
        <MediaRenderer data={media({ untrusted: true })} />
      </Chat>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open image" }));
    expect(within(dialog()).queryByRole("button", { name: "Next image" })).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close image viewer" }));

    fireEvent.click(screen.getByRole("button", { name: "View anyway" }));
    fireEvent.click(screen.getByRole("button", { name: "Open image" }));
    expect(counter()).toBe("1 / 2");
  });

  it("an image that failed to load leaves the gallery", () => {
    render(
      <Chat>
        <ImageThumbnails imageIds={["upload"]} />
        <MediaRenderer data={media({ caption: "Broken" })} />
      </Chat>,
    );
    fireEvent.error(screen.getByAltText("Broken"));
    fireEvent.click(screen.getByRole("button", { name: "Open image" }));
    expect(within(dialog()).queryByRole("button", { name: "Next image" })).toBeNull();
  });

  it("display_mode fullscreen opens the gallery at that image, with siblings before and after it", () => {
    // The images after it register in effects that run after its own
    // auto-open; the list must still include them.
    render(
      <Chat>
        <ImageThumbnails imageIds={["before"]} />
        <MediaRenderer data={media({ display_mode: "fullscreen", caption: "Auto" })} />
        <ImageThumbnails imageIds={["after1", "after2"]} />
      </Chat>,
    );
    expect(counter()).toBe("2 / 4");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Next image" }));
    expect(currentSrc()).toBe("/api/images/after1");
  });

  it("a fullscreen image that streams in does not take over an open viewer", () => {
    const { rerender } = render(
      <Chat>
        <ImageThumbnails key="a" imageIds={["a", "b"]} />
      </Chat>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open image 2 of 2" }));
    expect(counter()).toBe("2 / 2");
    rerender(
      <Chat>
        <ImageThumbnails key="a" imageIds={["a", "b"]} />
        <MediaRenderer key="m" data={media({ display_mode: "fullscreen", caption: "Late" })} />
      </Chat>,
    );
    expect(counter()).toBe("2 / 2");
    expect(currentSrc()).toBe("/api/images/b");
  });

  it("closing an auto-opened viewer does not refocus the composer", () => {
    render(
      <>
        <textarea aria-label="composer" autoFocus />
        <Chat>
          <MediaRenderer data={media({ display_mode: "fullscreen", caption: "Auto" })} />
        </Chat>
      </>,
    );
    // The composer had focus when the viewer opened itself.
    expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "Close image viewer" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close image viewer" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByLabelText("composer"));
  });

  it("video keeps the FullscreenFrame viewer", () => {
    render(
      <Chat>
        <MediaRenderer data={media({ media_type: "video", mime_type: "video/mp4", file_path: "/tmp/clip.mp4" })} />
      </Chat>,
    );
    document.querySelectorAll("video").forEach((el) => fireEvent.loadedMetadata(el));
    fireEvent.click(screen.getByTitle("Fullscreen"));
    expect(screen.queryByRole("dialog", { name: "Image viewer" })).toBeNull();
    expect(document.querySelectorAll("video")).toHaveLength(2);
  });

  it("outside a chat, an image still opens FullscreenFrame", () => {
    render(<MediaRenderer data={media({ caption: "Standalone" })} />);
    loadMedia();
    fireEvent.click(screen.getByTitle("Fullscreen"));
    expect(screen.queryByRole("dialog", { name: "Image viewer" })).toBeNull();
    expect(screen.getAllByAltText("Standalone")).toHaveLength(2);
  });
});
