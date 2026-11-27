/**
 * What the card-scope calls actually put on the wire.
 *
 * Same reasoning as api.workspaces.test.ts: every component test of this
 * surface mocks `../api` wholesale, which is right for testing a component and
 * useless for testing the request. Here the URL *is* the behaviour, and for
 * both of these the failure mode is a silent revert to a plausible-looking
 * older call that leaves every other test green.
 *
 *  - `listCards(true)` → `?includeHidden=true`. The route defaults it OFF,
 *    because the default listing must never include a card that opted out.
 *    The sidebar must ask: `utils/chatDimming` fades a chat whose card is
 *    closed OR hidden, and it can only do that for a card it was handed. Drop
 *    the argument — an easy edit, since `loadCards` reads as an ordinary
 *    default-listing fetch — and the dim silently stops agreeing with `cardLifecycle=unarchived` on exactly the
 *    rows that scope withholds. The hidden path is covered at the route
 *    (cards.hidden-listing.test.ts) and at the predicate (chatDimming.test.ts);
 *    this one line is what makes those two meet.
 *  - `listCards(false, { space, lifecycle: "open" })`, the Git page's call, puts
 *    both on the query string. Lose `lifecycle` and every poll pays for the
 *    whole archive again.
 *  - `listChats(..., "unarchived")` → `?cardLifecycle=unarchived`, and `"all"`
 *    → omitted, so the widest request stays byte-identical to what it was.
 *    `active` and `cardsOnly` are asserted too: they are published values older
 *    bundles still send, and a caller that still passes them must keep getting
 *    the narrow scope rather than being quietly upgraded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listCards, listChats } from "./api";

const fetchMock = vi.fn();

/** The URL of the single request the call under test made. */
function requestedUrl(): URL {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // Relative to a base only so `URLSearchParams` is available; the assertions
  // below are all about path and query, never the origin.
  return new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ cards: [], chats: [] }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("listCards", () => {
  /**
   * The one that matters. Mutation-check by changing the sidebar's
   * `listCards(true)` back to `listCards()` — this must go red.
   */
  it("asks for hidden cards when told to, because the route omits them by default", async () => {
    await listCards(true);
    expect(requestedUrl().searchParams.get("includeHidden")).toBe("true");
  });

  it("sends no query at all otherwise, so the default listing's request is unchanged", async () => {
    await listCards();
    const url = requestedUrl();
    expect(url.search).toBe("");
    expect(url.pathname.endsWith("/cards")).toBe(true);
  });

  it("sends the space and lifecycle scope the Git page asks for", async () => {
    await listCards(false, { space: "sp_work", lifecycle: "open" });
    const params = requestedUrl().searchParams;
    expect(params.get("space")).toBe("sp_work");
    expect(params.get("lifecycle")).toBe("open");
    expect(params.get("includeHidden")).toBeNull();
  });
});

describe("listChats card scope", () => {
  const scopeOf = async (...args: Parameters<typeof listChats>) => {
    await listChats(...args);
    return requestedUrl().searchParams.get("cardLifecycle");
  };

  it("sends the sidebar's browse scope", async () => {
    expect(await scopeOf(20, 0, undefined, undefined, undefined, true, undefined, "unarchived")).toBe("unarchived");
  });

  it("omits the parameter for all, keeping the unscoped request as it was", async () => {
    expect(await scopeOf(20, 0, undefined, undefined, undefined, true, undefined, "all")).toBeNull();
    // And with no scope argument whatsoever — the same request, from a caller
    // that predates the parameter.
    fetchMock.mockClear();
    expect(await scopeOf(20, 0)).toBeNull();
  });

  it("still sends the older narrow values a stale caller may pass", async () => {
    expect(await scopeOf(20, 0, undefined, undefined, undefined, true, undefined, "active")).toBe("active");
    fetchMock.mockClear();
    expect(await scopeOf(20, 0, undefined, undefined, undefined, true, undefined, "inactive")).toBe("inactive");
    fetchMock.mockClear();
    // The alias travels on its own key and is not rewritten into the new one.
    await listChats(20, 0, undefined, undefined, undefined, true, true);
    const url = requestedUrl();
    expect(url.searchParams.get("cardsOnly")).toBe("true");
    expect(url.searchParams.get("cardLifecycle")).toBeNull();
  });
});
