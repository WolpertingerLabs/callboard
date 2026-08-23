// @vitest-environment jsdom
/**
 * The regression these tests exist for is one line of a review log:
 *
 *     TypeError: Cannot destructure property 'removable' of 'e.removability'
 *     root html length: 0
 *
 * One row of one modal read a field an older bundle did not know about, and the
 * entire SPA unmounted. So the assertions are deliberately blunt: the subtree
 * that threw is replaced, **everything outside it still renders**, and the root
 * element is never empty. `root html length` is checked literally, because that
 * is the number the reviewer watched go to zero.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import ErrorBoundary, { ErrorFallback } from "./ErrorBoundary";
import ModalOverlay from "./ModalOverlay";

// React's dev build re-throws a boundary-caught error at the window so devtools
// can still see it; jsdom then dumps the whole stack to stderr for every one of
// these tests. Cancelling the event keeps the output readable without hiding
// anything the assertions rely on.
beforeEach(() => {
  const swallow = (e: ErrorEvent) => e.preventDefault();
  window.addEventListener("error", swallow);
  return () => window.removeEventListener("error", swallow);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The #364 crash shape, reproduced rather than approximated: a property read
 * off a field the server stopped sending. Not `throw new Error(...)` — the
 * point is that the failure arrives as an ordinary TypeError from ordinary
 * destructuring, which is what makes it impossible to anticipate one field at
 * a time.
 */
function WorkspaceRow({ workspace }: { workspace: { removability?: { removable: boolean } } }) {
  const { removable } = workspace.removability as { removable: boolean };
  return <div>{removable ? "Remove" : "Keep"}</div>;
}

/** Silences React's own dev-build logging of a caught error, and lets us assert on ours. */
function spyConsole() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("containment", () => {
  it("replaces only the subtree that threw", () => {
    spyConsole();
    render(
      <div>
        <aside>Chat list</aside>
        <ErrorBoundary region="This page" variant="region">
          <WorkspaceRow workspace={{}} />
        </ErrorBoundary>
        <footer>Composer</footer>
      </div>,
    );

    expect(screen.getByText("This page stopped working")).toBeTruthy();
    // The siblings outside the boundary are the whole point.
    expect(screen.getByText("Chat list")).toBeTruthy();
    expect(screen.getByText("Composer")).toBeTruthy();
  });

  it("never empties the root — `root html length: 0` is the bug", () => {
    spyConsole();
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);

    render(
      <ErrorBoundary region="Callboard" variant="root">
        <WorkspaceRow workspace={{}} />
      </ErrorBoundary>,
      { container: root },
    );

    expect(root.innerHTML.length).toBeGreaterThan(0);
    expect(screen.getByRole("alert")).toBeTruthy();
    root.remove();
  });

  it("reports the destructuring TypeError verbatim, so the message is still findable", () => {
    spyConsole();
    render(
      <ErrorBoundary region="This page">
        <WorkspaceRow workspace={{}} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("error-boundary-message").textContent).toMatch(/removable/);
  });

  it("renders a healthy subtree untouched", () => {
    render(
      <ErrorBoundary region="This page">
        <WorkspaceRow workspace={{ removability: { removable: true } }} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Remove")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the error still reaches the console", () => {
  it("logs the error object and the component stack, named by region", () => {
    const spy = spyConsole();
    render(
      <ErrorBoundary region="The sidebar">
        <WorkspaceRow workspace={{}} />
      </ErrorBoundary>,
    );

    const ours = spy.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("The sidebar crashed during render"));
    expect(ours).toBeTruthy();
    // The Error itself, not its message — a string would lose the stack, which
    // is the only thing that makes a production report actionable.
    expect(ours?.[1]).toBeInstanceOf(Error);
    expect((ours?.[1] as Error).stack).toBeTruthy();
    expect(String(ours?.[3])).toMatch(/WorkspaceRow/);
  });
});

describe("recovery", () => {
  /**
   * Throws or not according to a flag the test owns. Deliberately *not* a
   * counter mutated during render: React re-invokes a throwing render to
   * recover a better stack, so a self-decrementing component heals itself
   * before the boundary is ever exercised.
   */
  let broken = true;
  const FlakyRow = () => {
    if (!broken) return <div>Recovered content</div>;
    const missing = undefined as unknown as { removable: boolean };
    const { removable } = missing;
    return <div>{String(removable)}</div>;
  };

  afterEach(() => {
    broken = true;
  });

  it("'Try again' re-mounts the subtree and the content comes back", () => {
    spyConsole();
    render(
      <ErrorBoundary region="This page" variant="region">
        <FlakyRow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();

    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("Recovered content")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("re-mounts the subtree, which is what makes a region's fetches re-run", () => {
    spyConsole();
    // The whole argument for keeping "Try again" at region depth is that the
    // retry re-mounts ChatList / FolderList / Chat, so their loaders run again.
    // A re-render would leave the failed state exactly as it was.
    const lifecycle: string[] = [];
    let boom = false;

    function Watcher() {
      useEffect(() => {
        lifecycle.push("mount");
        return () => {
          lifecycle.push("unmount");
        };
      }, []);
      return <div>Sidebar content</div>;
    }

    function Thrower() {
      if (!boom) return null;
      const missing = undefined as unknown as { removable: boolean };
      const { removable } = missing;
      return <i>{String(removable)}</i>;
    }

    // Built fresh each time: re-rendering the *same* element object makes React
    // bail out of the subtree entirely, and `boom` would never be re-read.
    const tree = () => (
      <ErrorBoundary region="The sidebar" variant="region">
        <Watcher />
        <Thrower />
      </ErrorBoundary>
    );

    const { rerender } = render(tree());
    expect(lifecycle).toEqual(["mount"]);

    boom = true;
    rerender(tree());
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(lifecycle).toEqual(["mount", "unmount"]);

    boom = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(lifecycle).toEqual(["mount", "unmount", "mount"]);
    expect(screen.getByText("Sidebar content")).toBeTruthy();
  });

  it("stays on the fallback if the retry throws again", () => {
    spyConsole();
    render(
      <ErrorBoundary region="This page">
        <FlakyRow />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("clears itself when resetKey changes — navigating away is also a recovery", () => {
    spyConsole();
    const { rerender } = render(
      <ErrorBoundary region="This page" resetKey="/chat/broken">
        <FlakyRow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();

    broken = false;
    rerender(
      <ErrorBoundary region="This page" resetKey="/settings">
        <FlakyRow />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Recovered content")).toBeTruthy();
  });

  it("offers a reload everywhere, and reloads when it is clicked", () => {
    const reload = vi.fn();
    render(<ErrorFallback region="This page" variant="region" error={new Error("boom")} onReload={reload} onRetry={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("tells the user reloading is the fix — the stale-tab case they cannot guess", () => {
    render(<ErrorFallback region="Callboard" variant="root" error={new Error("boom")} onReload={() => {}} />);
    expect(screen.getByText(/before the server was updated/)).toBeTruthy();
  });

  it("offers no 'Try again' at the root, where there is no smaller subtree to re-mount", () => {
    spyConsole();
    render(
      <ErrorBoundary region="Callboard" variant="root">
        <WorkspaceRow workspace={{}} />
      </ErrorBoundary>,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
  });
});

describe("modals, via ModalOverlay", () => {
  it("contains a dialog that throws and leaves the app behind it alive", () => {
    spyConsole();
    render(
      <div>
        <main>Chat pane</main>
        <ModalOverlay>
          <WorkspaceRow workspace={{}} />
        </ModalOverlay>
      </div>,
    );

    expect(screen.getByText("This dialog stopped working")).toBeTruthy();
    expect(screen.getByText("Chat pane")).toBeTruthy();
  });

  it("offers no 'Try again', which at modal depth could not possibly work", () => {
    spyConsole();
    // `children` is built by the parent, which lives outside the boundary and
    // does not re-render when the boundary resets — the identical broken
    // element comes straight back. Region depth is the only place a retry
    // owns the subtree it would be re-mounting.
    render(
      <ModalOverlay>
        <WorkspaceRow workspace={{}} />
      </ModalOverlay>,
    );

    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("'Dismiss' closes the dialog in the parent's state, so it can be opened again", () => {
    spyConsole();
    // Hiding the fallback alone is a dead end: the parent still holds
    // `open === true`, so re-opening sets state that has not changed, React
    // bails out, and the user gets no overlay and no feedback at all.
    function Parent() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Manage
          </button>
          {open && (
            <ModalOverlay onClose={() => setOpen(false)}>
              <WorkspaceRow workspace={{}} />
            </ModalOverlay>
          )}
        </div>
      );
    }

    render(<Parent />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();

    // Re-opening reaches the boundary again rather than silently doing nothing.
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByText("This dialog stopped working")).toBeTruthy();
  });

  it("falls through to the enclosing region when a dialog throws before it returns the overlay", () => {
    spyConsole();
    // The boundary lives inside ModalOverlay, so it has not mounted yet at this
    // point. Documented behaviour, not an accident: the layering is what covers
    // it, and this pins that the region boundary does.
    function BrokenDialog() {
      const row = {} as { removability?: { removable: boolean } };
      const { removable } = row.removability as { removable: boolean };
      return (
        <ModalOverlay>
          <div>{String(removable)}</div>
        </ModalOverlay>
      );
    }

    render(
      <ErrorBoundary region="The sidebar" variant="region">
        <BrokenDialog />
      </ErrorBoundary>,
    );

    expect(screen.getByText("The sidebar stopped working")).toBeTruthy();
  });

  it("'Dismiss' removes the backdrop as well as the fallback", () => {
    spyConsole();
    const { container } = render(
      <div>
        <main>Chat pane</main>
        <ModalOverlay>
          <WorkspaceRow workspace={{}} />
        </ModalOverlay>
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("alert")).toBeNull();
    // Nothing fixed-position is left over the app: a leftover backdrop would be
    // a full-screen click trap, because the dialog that threw owned the only
    // close button and Escape handler.
    expect(container.querySelectorAll("div").length).toBe(1);
    expect(screen.getByText("Chat pane")).toBeTruthy();
  });
});

describe("what the fallback paints", () => {
  /**
   * Guarded here rather than only in a browser, because the two ways this has
   * gone wrong are both invisible to jsdom's layout and both perfectly visible
   * to a user: an opaque panel over the modal backdrop, and the main pane's
   * `--bg` painted over the sidebar's `--bg-sidebar` column.
   */
  function wrapperOf(variant: "root" | "region" | "modal") {
    render(<ErrorFallback region="X" variant={variant} error={new Error("boom")} onReload={() => {}} />);
    return screen.getByRole("alert") as HTMLElement;
  }

  it("paints no background of its own — the column or the body behind it owns that token", () => {
    // Hardcoding `--bg` here is what put a lighter panel down the sidebar in
    // dark mode. One wrapper serves both columns, so it inherits instead.
    expect(wrapperOf("region").style.background).toBe("");
    cleanup();
    expect(wrapperOf("root").style.background).toBe("");
  });

  it("does not stretch or paint at modal depth, where it sits on the backdrop", () => {
    const modal = wrapperOf("modal");
    expect(modal.style.background).toBe("");
    // `height: 100%` is the region wrapper's, and inheriting it here drew a
    // solid column down the middle of the app.
    expect(modal.style.height).toBe("");
  });

  it("still fills its column at region depth", () => {
    expect(wrapperOf("region").style.height).toBe("100%");
  });

  it("uses only CSS variables — no literal colours anywhere in the fallback", () => {
    cleanup();
    render(<ErrorFallback region="X" variant="region" error={new Error("boom")} onReload={() => {}} onRetry={() => {}} />);
    const alert = screen.getByRole("alert");
    const inline = [alert, ...alert.querySelectorAll<HTMLElement>("*")].map((el) => el.getAttribute("style") ?? "").join(";");
    expect(inline).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(inline).not.toMatch(/\brgba?\(/i);
    expect(inline).toMatch(/var\(--/);
  });
});
