// @vitest-environment jsdom
/**
 * The star is a toggle, and a toggle has exactly one accessible name.
 *
 * It used to change its `aria-label` with its state *and* set `aria-pressed`,
 * which a screen reader announces as "Unfavorite skill X, pressed" — the state
 * twice, and the two halves reading as contradictory. The name is static now
 * and `aria-pressed` carries the state alone.
 *
 * The `disabled` case is not cosmetic: until the favorites list has actually
 * been read, writing it would destroy it (see `utils/favorites.ts`), and the
 * module refuses. Disabling here is what makes that refusal visible instead of
 * a click that silently does nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import FavoriteStar from "./FavoriteStar";

afterEach(cleanup);

const star = () => screen.getByRole("button", { name: 'Favorite skill "release-notes"' });

describe("FavoriteStar", () => {
  it("keeps one accessible name and lets aria-pressed carry the state", () => {
    const { rerender } = render(<FavoriteStar active={false} onToggle={vi.fn()} label={'skill "release-notes"'} />);
    expect(star().getAttribute("aria-pressed")).toBe("false");

    rerender(<FavoriteStar active={true} onToggle={vi.fn()} label={'skill "release-notes"'} />);
    // Same name — the query would throw if it had become "Unfavorite …".
    expect(star().getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the tooltip imperative and state-dependent", () => {
    const { rerender } = render(<FavoriteStar active={false} onToggle={vi.fn()} label={'skill "release-notes"'} />);
    expect(star().getAttribute("title")).toBe('Pin skill "release-notes" to the New Chat launchpad');

    rerender(<FavoriteStar active={true} onToggle={vi.fn()} label={'skill "release-notes"'} />);
    expect(star().getAttribute("title")).toBe('Remove skill "release-notes" from the New Chat launchpad');
  });

  it("toggles on click", () => {
    const onToggle = vi.fn();
    render(<FavoriteStar active={false} onToggle={onToggle} label={'skill "release-notes"'} />);

    fireEvent.click(star());

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("does not fire while disabled, and says why", () => {
    const onToggle = vi.fn();
    render(<FavoriteStar active={false} onToggle={onToggle} label={'skill "release-notes"'} disabled />);

    fireEvent.click(star());

    expect(onToggle).not.toHaveBeenCalled();
    expect((star() as HTMLButtonElement).disabled).toBe(true);
    expect(star().getAttribute("title")).toBe("Loading your favorites…");
  });

  it("says what actually went wrong when the read failed rather than 'loading'", () => {
    render(<FavoriteStar active={false} onToggle={vi.fn()} label={'skill "release-notes"'} disabled disabledReason="Daemon unreachable." />);

    expect(star().getAttribute("title")).toBe("Daemon unreachable.");
  });
});
