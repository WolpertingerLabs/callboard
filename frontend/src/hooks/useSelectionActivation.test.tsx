/**
 * The selection contract, asserted once against the hook itself.
 *
 * Every selectable surface (today the sidebar's chat rows) answers clicks,
 * long presses and modified clicks through `useSelectionActivation`, and their
 * own tests deliberately don't re-test these rules. So this is where they
 * live: what a click, a long press and a modified click *mean*, independent of
 * any row's layout.
 *
 * Ported from the board's card-face parity suite when the board's Cards and
 * List views were removed. The harness below is the minimum a surface has to
 * render to use the hook correctly: an outer element carrying the hover and
 * gesture props, an open button, and the checkbox as its sibling.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { useSelectionActivation, type UseSelectionActivationOptions } from "./useSelectionActivation";

type HarnessProps = Omit<UseSelectionActivationOptions, "label"> & { selected?: boolean };

function Harness({ selected = false, ...options }: HarnessProps) {
  const a = useSelectionActivation({ label: "Ship the thing", ...options });
  return (
    <div {...a.hoverProps} {...a.gestureProps}>
      {options.onToggleSelect && (
        <button
          role="checkbox"
          aria-checked={selected}
          aria-label={a.checkboxLabel}
          disabled={a.inert}
          tabIndex={a.showCheckbox ? 0 : -1}
          onClick={(e) => options.onToggleSelect?.(e)}
          {...a.checkboxFocusProps}
          style={{ opacity: a.showCheckbox ? 1 : 0, pointerEvents: a.showCheckbox ? "auto" : "none" }}
        />
      )}
      <button disabled={a.inert} aria-pressed={options.onToggleSelect && options.selectionMode ? selected : undefined} onClick={a.handleClick}>
        Ship the thing
      </button>
    </div>
  );
}

/** The row's main surface — the open button, not the checkbox. */
const face = () => screen.getByRole("button", { name: "Ship the thing" });
/** The row's outer element, which is where hover and gesture props land. */
const outer = (container: HTMLElement) => container.firstElementChild as HTMLElement;

function longPress(el: HTMLElement) {
  fireEvent.pointerDown(el, { pointerType: "touch", clientX: 10, clientY: 20 });
  act(() => void vi.advanceTimersByTime(500));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSelectionActivation", () => {
  describe("the checkbox affordance", () => {
    it("is hidden until something asks for it", () => {
      render(<Harness onClick={vi.fn()} onToggleSelect={vi.fn()} />);
      const box = screen.getByRole("checkbox");
      // Hidden by opacity rather than by unmounting: a checkbox that only
      // exists on :hover is one keyboard users can never find.
      expect(box.style.opacity).toBe("0");
      expect(box.style.pointerEvents).toBe("none");
    });

    it("is revealed by hover", () => {
      const { container } = render(<Harness onClick={vi.fn()} onToggleSelect={vi.fn()} />);
      fireEvent.mouseEnter(outer(container));
      expect(screen.getByRole("checkbox").style.opacity).toBe("1");

      fireEvent.mouseLeave(outer(container));
      expect(screen.getByRole("checkbox").style.opacity).toBe("0");
    });

    it("is revealed by keyboard focus, not only by the mouse", () => {
      render(<Harness onClick={vi.fn()} onToggleSelect={vi.fn()} />);
      const box = screen.getByRole("checkbox");
      fireEvent.focus(box);
      expect(box.style.opacity).toBe("1");
      expect(box.style.pointerEvents).toBe("auto");
    });

    it("is revealed by selection mode, with no hover at all", () => {
      render(<Harness onClick={vi.fn()} selectionMode onToggleSelect={vi.fn()} />);
      expect(screen.getByRole("checkbox").style.opacity).toBe("1");
    });

    it("is never shown when the surface offers no selection, however it is hovered", () => {
      const { container } = render(<Harness onClick={vi.fn()} />);
      fireEvent.mouseEnter(outer(container));
      expect(screen.queryByRole("checkbox")).toBeNull();
    });

    it("names itself from the label", () => {
      render(<Harness onClick={vi.fn()} onToggleSelect={vi.fn()} />);
      expect(screen.getByRole("checkbox").getAttribute("aria-label")).toBe("Select Ship the thing");
    });
  });

  describe("out of the selection's scope", () => {
    it("answers neither a click nor a toggle", () => {
      const onClick = vi.fn();
      const onToggleSelect = vi.fn();
      render(<Harness onClick={onClick} selectionMode selectable={false} onToggleSelect={onToggleSelect} />);

      fireEvent.click(face());
      expect(onClick).not.toHaveBeenCalled();
      expect(onToggleSelect).not.toHaveBeenCalled();
    });

    it("hides the checkbox and reports the row inert", () => {
      render(<Harness onClick={vi.fn()} selectionMode selectable={false} onToggleSelect={vi.fn()} />);
      const box = screen.getByRole("checkbox", { hidden: true }) as HTMLButtonElement;
      expect(box.style.opacity).toBe("0");
      // A focusable button still fires on Enter however transparent it is.
      expect(box.disabled).toBe(true);
    });

    it("is not inert outside selection mode, even when not selectable", () => {
      const onClick = vi.fn();
      render(<Harness onClick={onClick} selectable={false} onToggleSelect={vi.fn()} />);
      fireEvent.click(face());
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe("gestures", () => {
    it("enters selection on a long press, without opening", () => {
      const onClick = vi.fn();
      const onLongPress = vi.fn();
      render(<Harness onClick={onClick} onLongPress={onLongPress} onToggleSelect={vi.fn()} />);

      longPress(face());
      expect(onLongPress).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });

    it("swallows the click the browser emits after that press", () => {
      const onClick = vi.fn();
      render(<Harness onClick={onClick} onLongPress={vi.fn()} onToggleSelect={vi.fn()} />);

      longPress(face());
      fireEvent.click(face());
      expect(onClick).not.toHaveBeenCalled();

      // Only that one click, though — the row is not left dead.
      fireEvent.click(face());
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("leaves the browser's own context menu alone when it has no long press to offer", () => {
      render(<Harness onClick={vi.fn()} />);
      // Not defaultPrevented: taking the native menu away and putting nothing
      // in its place is a pure loss.
      expect(fireEvent.contextMenu(face())).toBe(true);
    });

    it("routes a modified click to the selection rather than opening", () => {
      for (const modifier of ["metaKey", "ctrlKey", "shiftKey"] as const) {
        const onClick = vi.fn();
        const onToggleSelect = vi.fn();
        render(<Harness onClick={onClick} onToggleSelect={onToggleSelect} />);

        fireEvent.click(face(), { [modifier]: true });
        expect(onToggleSelect, modifier).toHaveBeenCalledTimes(1);
        expect(onClick, modifier).not.toHaveBeenCalled();
        cleanup();
      }
    });

    it("opens on a modified click when the surface offers no selection", () => {
      const onClick = vi.fn();
      render(<Harness onClick={onClick} />);
      fireEvent.click(face(), { metaKey: true });
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("opens on a plain click", () => {
      const onClick = vi.fn();
      const onToggleSelect = vi.fn();
      render(<Harness onClick={onClick} onToggleSelect={onToggleSelect} />);

      fireEvent.click(face());
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onToggleSelect).not.toHaveBeenCalled();
    });

    it("toggles instead of opening once selection mode is on", () => {
      const onClick = vi.fn();
      const onToggleSelect = vi.fn();
      render(<Harness onClick={onClick} selectionMode onToggleSelect={onToggleSelect} onLongPress={vi.fn()} />);

      fireEvent.click(face());
      expect(onToggleSelect).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe("handleActivate", () => {
    it("runs the same rules in front of a different destination", () => {
      function Alt({ selectionMode }: { selectionMode: boolean }) {
        const a = useSelectionActivation({ label: "x", onClick: vi.fn(), onToggleSelect: toggle, selectionMode });
        return <button onClick={a.handleActivate(other)}>alt</button>;
      }
      const other = vi.fn();
      const toggle = vi.fn();
      const { rerender } = render(<Alt selectionMode={false} />);
      fireEvent.click(screen.getByRole("button", { name: "alt" }));
      expect(other).toHaveBeenCalledTimes(1);

      rerender(<Alt selectionMode />);
      fireEvent.click(screen.getByRole("button", { name: "alt" }));
      expect(other).toHaveBeenCalledTimes(1);
      expect(toggle).toHaveBeenCalledTimes(1);
    });
  });
});
