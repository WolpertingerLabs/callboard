import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import type { SpaceListItem } from "shared/types/space.js";
import { ALL_SPACES, DEFAULT_SPACE_ID } from "shared/types/space.js";
import { getChatSpace, listSpaces } from "../api";
import { getLastSpace, saveLastSpace } from "../utils/localStorage";
import { useSessionContext } from "./SessionContext";

/**
 * The active space — which partition of the chat list this TAB is looking at.
 *
 * Owned state, per tab. Resolution order on load: `?space=` in the URL, then
 * this tab's own sessionStorage, then the browser-wide last-used space in
 * localStorage, then General. Switching writes all three, so a reload keeps
 * the tab where it was, a new tab opens where you last were, and two tabs can
 * still sit in different spaces. `/chat/:id` stays unprefixed: opening a chat
 * that lives in another space switches this tab to it, with a quiet notice.
 */
export interface SpaceContextValue {
  /** True under a provider. Without one every consumer behaves as before spaces. */
  enabled: boolean;
  /** Live (unarchived) spaces in switcher order; General is always first. */
  spaces: SpaceListItem[];
  /** A space id or "all". Undefined without a provider — requests go unscoped. */
  activeSpaceId: string | undefined;
  /** The active space's record; undefined for "all" or before the list loads. */
  activeSpace: SpaceListItem | undefined;
  setActiveSpace: (id: string) => void;
  refreshSpaces: () => Promise<void>;
  spaceById: (id: string | undefined) => SpaceListItem | undefined;
  /** A short message to surface (e.g. after an automatic switch), or null. */
  notice: string | null;
  dismissNotice: () => void;
}

const FALLBACK: SpaceContextValue = {
  enabled: false,
  spaces: [],
  activeSpaceId: undefined,
  activeSpace: undefined,
  setActiveSpace: () => {},
  refreshSpaces: async () => {},
  spaceById: () => undefined,
  notice: null,
  dismissNotice: () => {},
};

/** Exported for tests, which supply a value directly. */
export const SpaceContext = createContext<SpaceContextValue>(FALLBACK);

export function useSpaces(): SpaceContextValue {
  return useContext(SpaceContext);
}

const TAB_KEY = "callboard-active-space";
const SPACE_PARAM = "space";

function readTabSpace(): string | null {
  try {
    return sessionStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

function writeTabSpace(id: string): void {
  try {
    sessionStorage.setItem(TAB_KEY, id);
  } catch {
    /* private mode */
  }
}

const validScope = (value: string | null | undefined): value is string => !!value && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** The first space this tab should show, before the space list has loaded. */
export function initialSpaceId(search: string): string {
  const fromUrl = new URLSearchParams(search).get(SPACE_PARAM);
  if (validScope(fromUrl)) return fromUrl;
  const fromTab = readTabSpace();
  if (validScope(fromTab)) return fromTab;
  return getLastSpace() ?? DEFAULT_SPACE_ID;
}

export function SpaceProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { metadataVersion } = useSessionContext();
  const [spaces, setSpaces] = useState<SpaceListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeSpaceId, setActiveSpaceId] = useState<string>(() => initialSpaceId(location.search));
  /** The space this tab was auto-switched to, while its notice is showing. Named at render, once the list has it. */
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);

  const refreshSpaces = useCallback(async () => {
    try {
      const list = await listSpaces();
      // A daemon older than spaces answers this route with something else
      // (the SPA fallback, a 404 body): no spaces, and no switching away.
      if (!Array.isArray(list)) return;
      setSpaces(list);
      setLoaded(true);
    } catch {
      /* keep the last list; the switcher simply stays as it was */
    }
  }, []);

  useEffect(() => {
    void refreshSpaces();
  }, [refreshSpaces]);

  // Another tab (or an agent) may have created, renamed or archived a space;
  // every space write bumps the metadata version. Debounced like the list.
  useEffect(() => {
    if (metadataVersion === 0) return;
    const timer = setTimeout(() => void refreshSpaces(), 400);
    return () => clearTimeout(timer);
  }, [metadataVersion, refreshSpaces]);

  // Keep the URL saying where this tab is, without disturbing anything else
  // on it (other params, router state the chat page reads).
  const writeUrl = useCallback(
    (id: string) => {
      const params = new URLSearchParams(location.search);
      if (params.get(SPACE_PARAM) === id) return;
      params.set(SPACE_PARAM, id);
      navigate({ pathname: location.pathname, search: `?${params}` }, { replace: true, state: location.state });
    },
    [location.pathname, location.search, location.state, navigate],
  );

  const setActiveSpace = useCallback(
    (id: string) => {
      setActiveSpaceId(id);
      writeTabSpace(id);
      saveLastSpace(id);
      writeUrl(id);
    },
    [writeUrl],
  );

  // A link (or back/forward) carrying ?space= is an instruction.
  useEffect(() => {
    const fromUrl = new URLSearchParams(location.search).get(SPACE_PARAM);
    if (validScope(fromUrl) && fromUrl !== activeSpaceId) {
      setActiveSpaceId(fromUrl);
      writeTabSpace(fromUrl);
    }
    // activeSpaceId deliberately omitted: only a URL change should run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // A space that no longer exists (deleted or archived elsewhere) falls back
  // to General rather than leaving the tab on an empty list.
  useEffect(() => {
    if (!loaded || activeSpaceId === ALL_SPACES) return;
    if (!spaces.some((s) => s.id === activeSpaceId)) setActiveSpace(DEFAULT_SPACE_ID);
  }, [loaded, spaces, activeSpaceId, setActiveSpace]);

  // Opening a chat that lives in another space switches to it. Asked once per
  // chat id; the "all" view already shows everything, so it never switches.
  //
  // Keyed on the chat id ALONE, reading everything else through a ref: the
  // space list typically lands while this request is in flight, and an effect
  // that also depended on it would cancel the answer and — having already
  // marked the chat as asked — never ask again.
  const latest = useRef({ activeSpaceId, spaces, setActiveSpace });
  useEffect(() => {
    latest.current = { activeSpaceId, spaces, setActiveSpace };
  });
  const chatId = matchPath("/chat/:id", location.pathname)?.params.id;
  useEffect(() => {
    if (!chatId || chatId === "new") return;
    if (latest.current.activeSpaceId === ALL_SPACES) return;
    let cancelled = false;
    getChatSpace(chatId)
      .then((spaceId) => {
        const now = latest.current;
        if (cancelled || spaceId === now.activeSpaceId || now.activeSpaceId === ALL_SPACES) return;
        now.setActiveSpace(spaceId);
        setSwitchedTo(spaceId);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  useEffect(() => {
    if (!switchedTo) return;
    const timer = setTimeout(() => setSwitchedTo(null), 5000);
    return () => clearTimeout(timer);
  }, [switchedTo]);

  const value = useMemo<SpaceContextValue>(() => {
    const byId = new Map(spaces.map((s) => [s.id, s]));
    const target = switchedTo ? byId.get(switchedTo) : undefined;
    const notice = switchedTo
      ? `Switched to ${target ? `${target.emoji ? `${target.emoji} ` : ""}${target.name}` : "this chat’s space"} — this chat lives there.`
      : null;
    return {
      enabled: true,
      spaces,
      activeSpaceId,
      activeSpace: byId.get(activeSpaceId),
      setActiveSpace,
      refreshSpaces,
      spaceById: (id) => (id ? byId.get(id) : undefined),
      notice,
      dismissNotice: () => setSwitchedTo(null),
    };
  }, [spaces, activeSpaceId, setActiveSpace, refreshSpaces, switchedTo]);

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>;
}
