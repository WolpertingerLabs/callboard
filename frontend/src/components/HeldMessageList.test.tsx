// @vitest-environment jsdom
/**
 * The held messages ("Enqueue Send") at the end of the transcript: one muted,
 * dashed bubble each with its attachments, a line saying where it stands
 * (queued with its place, delivering, paused or failed with the daemon's
 * reason, an unknown state as waiting), and Send now / Edit / Remove — plus
 * Resume queue while any is paused or failed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { HeldMessage } from "shared/types/index.js";
import HeldMessageList, { heldStateLine, heldSummary } from "./HeldMessageList";

afterEach(cleanup);

const held = (id: string, state: HeldMessage["state"], extra: Partial<HeldMessage> = {}): HeldMessage => ({
  id,
  chatId: "chat-1",
  text: `message ${id}`,
  createdAt: "2026-11-22T10:00:00.000Z",
  state,
  ...extra,
});

function renderList(items: HeldMessage[], props: Partial<React.ComponentProps<typeof HeldMessageList>> = {}) {
  const handlers = { onSendNow: vi.fn(), onEdit: vi.fn(), onRemove: vi.fn(), onResume: vi.fn() };
  render(<HeldMessageList items={items} {...handlers} {...props} />);
  return handlers;
}

const cards = () => screen.getAllByRole("article", { name: /^Held message \d+ of \d+$/ });
const line = (card: HTMLElement) => card.querySelector("[data-held-line]")!.textContent;

describe("heldStateLine", () => {
  it("says where each state stands", () => {
    expect(heldStateLine(held("a", "queued"))).toBe("Queued · sends when this turn ends");
    expect(heldStateLine(held("a", "queued"), 2)).toBe("Queued · #2 in queue");
    expect(heldStateLine(held("a", "delivering"))).toBe("Sending…");
    expect(heldStateLine(held("a", "paused", { reason: "You stopped the run." }))).toBe("Paused · You stopped the run.");
    expect(heldStateLine(held("a", "failed", { reason: "The branch changed." }))).toBe("Couldn't send · The branch changed.");
    // A state a newer daemon added is "not sending yet", never dropped.
    expect(heldStateLine(held("a", "later" as HeldMessage["state"]))).toBe("Waiting");
  });
});

describe("HeldMessageList", () => {
  it("shows nothing with nothing held, but keeps its (empty) live region mounted", () => {
    renderList([]);
    expect(screen.queryByRole("region", { name: "Held messages" })).toBeNull();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("labels each item with its position, and has one live region summing the list up", () => {
    renderList([held("a", "queued"), held("b", "queued"), held("c", "paused", { reason: "x" })]);
    expect(cards().map((card) => card.getAttribute("aria-label"))).toEqual(["Held message 1 of 3", "Held message 2 of 3", "Held message 3 of 3"]);
    const live = screen.getAllByRole("status");
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toBe("3 held messages: 2 queued, 1 paused");
  });

  it("shows a disabled action as disabled, not clickable", () => {
    renderList([held("a", "delivering")]);
    const sendNow = within(cards()[0]).getByRole("button", { name: "Send now" });
    expect(sendNow.style.cursor).toBe("default");
  });

  it("shows one queued message as waiting on this turn, with its attachments and no Resume", () => {
    renderList([held("a", "queued", { images: [{ id: "img-1", originalName: "diagram.png" }] })]);
    const [card] = cards();
    expect(card.textContent).toContain("message a");
    expect(card.textContent).toContain("diagram.png");
    expect(line(card)).toBe("Queued · sends when this turn ends");
    expect(screen.queryByRole("button", { name: "Resume queue" })).toBeNull();
  });

  it("numbers several queued messages", () => {
    renderList([held("a", "queued"), held("b", "queued")]);
    expect(cards().map((card) => line(card))).toEqual(["Queued · #1 in queue", "Queued · #2 in queue"]);
  });

  it("shows paused and failed reasons, and offers Resume queue", () => {
    const { onResume } = renderList([held("a", "paused", { reason: "You stopped the run." }), held("b", "failed", { reason: "Engine down." })]);
    expect(line(cards()[0])).toBe("Paused · You stopped the run.");
    expect(line(cards()[1])).toBe("Couldn't send · Engine down.");
    fireEvent.click(screen.getByRole("button", { name: "Resume queue" }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("greys a delivering message's actions, and a busy one's", () => {
    renderList([held("a", "delivering"), held("b", "queued"), held("c", "queued")], { busyIds: new Set(["c"]) });
    const buttons = (card: HTMLElement) => within(card).getAllByRole("button") as HTMLButtonElement[];
    const [delivering, queued, busy] = cards();
    expect(buttons(delivering).every((b) => b.disabled)).toBe(true);
    expect(buttons(queued).every((b) => !b.disabled)).toBe(true);
    expect(buttons(busy).every((b) => b.disabled)).toBe(true);
  });

  it("hands each action the message it is on", () => {
    const items = [held("a", "queued"), held("b", "failed", { reason: "x" })];
    const { onSendNow, onEdit, onRemove } = renderList(items);
    const second = cards()[1];
    fireEvent.click(within(second).getByRole("button", { name: "Send now" }));
    fireEvent.click(within(second).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(second).getByRole("button", { name: "Remove" }));
    expect(onSendNow).toHaveBeenCalledWith(items[1]);
    expect(onEdit).toHaveBeenCalledWith(items[1]);
    expect(onRemove).toHaveBeenCalledWith(items[1]);
  });

  it("disables Resume queue while a resume is out", () => {
    renderList([held("a", "paused")], { resuming: true });
    expect((screen.getByRole("button", { name: "Resume queue" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("heldSummary", () => {
  it("counts the items by state, an unknown state as waiting", () => {
    expect(heldSummary([])).toBe("");
    expect(heldSummary([held("a", "queued")])).toBe("1 held message: 1 queued");
    expect(heldSummary([held("a", "failed"), held("b", "delivering"), held("c", "later" as HeldMessage["state"])])).toBe(
      "3 held messages: 1 couldn't send, 1 sending, 1 waiting",
    );
  });
});
