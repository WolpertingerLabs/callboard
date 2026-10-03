// @vitest-environment jsdom
/**
 * The dropdown floats over the settings form, so it carries the deep elevation
 * token rather than the card-level one — and never a literal colour.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import OpenRouterModelSelector from "./OpenRouterModelSelector";

vi.mock("../api", () => ({
  getOpenRouterCatalog: vi.fn(async () => ({ models: [{ id: "anthropic/claude-example", name: "Claude Example" }], aliases: [] })),
}));

afterEach(cleanup);

describe("OpenRouterModelSelector dropdown", () => {
  it("uses the deep shadow token", async () => {
    render(<OpenRouterModelSelector value="" onChange={() => {}} placeholder="model" />);
    fireEvent.focus(screen.getByPlaceholderText("model"));
    const row = await screen.findByText("anthropic/claude-example");
    const dropdown = row.closest('div[style*="box-shadow"]') as HTMLElement;
    expect(dropdown.style.boxShadow).toBe("var(--shadow-lg)");
  });
});
