// @vitest-environment jsdom
/**
 * The sidebar's Pinned/Recent collapse state, keyed `pinned`/`recent`.
 *
 * The bug this suite exists for: back when the sidebar had a flat layout beside
 * the tree, `ChatList` and `ChatTreeList` BOTH called this hook and both were
 * mounted at once. With per-caller `useState` the two copies drifted —
 * collapsing a section in the tree layout left `ChatList`'s copy expanded, and
 * because the layout was `ChatList`'s own state (so it never remounted),
 * switching back to flat handed the user a section they had just collapsed.
 *
 * The tree is now the only layout and `ChatTreeList` the only caller, so the
 * "two consumers" tests below no longer mirror a live arrangement. They stay
 * because they pin the property that made the fix work — one shared store, not
 * one per caller — which a second consumer would otherwise be free to break
 * again. A single-consumer test cannot see it, which is exactly why the
 * component-level remount test did not.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getChatSectionExpanded, saveChatSectionExpanded } from "../utils/localStorage";
import { resetChatSectionExpansion, useChatSectionExpansion } from "./useChatSectionExpansion";

/** Stands in for one of the two lists: reports what it would render. */
function Consumer({ name }: { name: string }) {
  const { isExpanded, toggle } = useChatSectionExpansion();
  return (
    <div>
      <span data-testid={`${name}-pinned`}>{String(isExpanded("pinned"))}</span>
      <span data-testid={`${name}-recent`}>{String(isExpanded("recent"))}</span>
      <button onClick={() => toggle("recent")}>toggle {name} recent</button>
    </div>
  );
}

const shown = (name: string, key: "pinned" | "recent") => screen.getByTestId(`${name}-${key}`).textContent;

beforeEach(() => {
  localStorage.clear();
  resetChatSectionExpansion();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetChatSectionExpansion();
});

describe("useChatSectionExpansion", () => {
  it("starts both sections expanded", () => {
    render(<Consumer name="flat" />);
    expect([shown("flat", "pinned"), shown("flat", "recent")]).toEqual(["true", "true"]);
  });

  it("keeps two simultaneously mounted consumers in sync", () => {
    // Two lists mounted at once — the arrangement the flat/tree split used to
    // produce. The one NOT clicked is the one that used to go stale.
    render(
      <>
        <Consumer name="flat" />
        <Consumer name="tree" />
      </>,
    );
    fireEvent.click(screen.getByText("toggle tree recent"));

    expect(shown("tree", "recent")).toBe("false");
    // The assertion the old per-caller useState failed: the untouched consumer
    // must not still believe the section is open.
    expect(shown("flat", "recent")).toBe("false");
    // ...and the section nobody touched is unaffected.
    expect(shown("flat", "pinned")).toBe("true");
  });

  it("lets either consumer toggle a section the other one collapsed", () => {
    // The mirror case: collapse in one, expand from the other. With drifting
    // copies the second click read a stale `prev` and appeared to do nothing.
    render(
      <>
        <Consumer name="flat" />
        <Consumer name="tree" />
      </>,
    );
    fireEvent.click(screen.getByText("toggle flat recent"));
    fireEvent.click(screen.getByText("toggle tree recent"));

    expect([shown("flat", "recent"), shown("tree", "recent")]).toEqual(["true", "true"]);
    expect(getChatSectionExpanded("recent")).toBe(true);
  });

  it("writes the choice to storage, and reads it back on a fresh mount", () => {
    render(<Consumer name="flat" />);
    fireEvent.click(screen.getByText("toggle flat recent"));
    expect(getChatSectionExpanded("recent")).toBe(false);

    cleanup();
    resetChatSectionExpansion(); // a reload: nothing cached in memory
    render(<Consumer name="flat" />);
    expect(shown("flat", "recent")).toBe("false");
    expect(shown("flat", "pinned")).toBe("true");
  });
});

/**
 * The stored value is JSON, so it can be anything a hand-edit or an older
 * build left behind. The callers render `isExpanded(key) && rows`, where a
 * non-boolean does not fail loudly — it renders itself into the sidebar.
 */
describe("getChatSectionExpanded", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("round-trips one section without disturbing the other", () => {
    saveChatSectionExpanded("recent", false);
    expect(getChatSectionExpanded("recent")).toBe(false);
    expect(getChatSectionExpanded("pinned")).toBe(true);
  });

  it("returns a real boolean for a junk stored value, not the junk itself", () => {
    // `?? true` would hand back 0 here, and `0 && rows` renders a literal "0"
    // in the sidebar where the chats belong.
    localStorage.setItem("claude-code-settings", JSON.stringify({ chatSectionsExpanded: { pinned: 0, recent: "yes" } }));
    expect(getChatSectionExpanded("pinned")).toBe(true);
    expect(getChatSectionExpanded("recent")).toBe(true);
  });

  it("defaults to expanded when the whole key is absent or malformed", () => {
    expect(getChatSectionExpanded("pinned")).toBe(true);
    localStorage.setItem("claude-code-settings", JSON.stringify({ chatSectionsExpanded: "nonsense" }));
    expect(getChatSectionExpanded("recent")).toBe(true);
  });

  /**
   * The record is shared with a bundle predating the "Show archived" refactor,
   * which stores `active`/`inactive` in it for the Open/Archived split. The
   * keys do not collide, and a write from here must not take that tab's
   * collapsed sections away — same rule the retired `chatsCardLifecycle` keys
   * are held to next door.
   */
  it("leaves an older bundle's section keys alone when writing its own", () => {
    localStorage.setItem("claude-code-settings", JSON.stringify({ chatSectionsExpanded: { active: false, inactive: true } }));
    saveChatSectionExpanded("pinned", false);

    const stored = JSON.parse(localStorage.getItem("claude-code-settings")!);
    expect(stored.chatSectionsExpanded).toEqual({ active: false, inactive: true, pinned: false });
    // And this bundle reads none of the legacy keys as its own.
    expect(getChatSectionExpanded("recent")).toBe(true);
  });
});
