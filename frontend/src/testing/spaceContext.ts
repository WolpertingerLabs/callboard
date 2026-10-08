import type { SpaceListItem } from "shared/types/space.js";
import type { SpaceContextValue } from "../contexts/SpaceContext";

/** A space row for tests. */
export function testSpace(id: string, name: string, extra: Partial<SpaceListItem> = {}): SpaceListItem {
  return { id, name, order: 0, chatCount: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra };
}

/**
 * A SpaceContext value for tests that render a consumer without the provider.
 * `spaces` is split into live and archived the way the provider splits it, and
 * `spaceById` resolves both.
 */
export function makeSpaceContext(spaces: SpaceListItem[], overrides: Partial<SpaceContextValue> = {}): SpaceContextValue {
  const live = spaces.filter((s) => !s.archived);
  const activeSpaceId = overrides.activeSpaceId ?? "default";
  return {
    enabled: true,
    spaces: live,
    archivedSpaces: spaces.filter((s) => s.archived),
    activeSpaceId,
    activeSpace: spaces.find((s) => s.id === activeSpaceId),
    setActiveSpace: () => {},
    refreshSpaces: async () => {},
    spaceById: (id) => spaces.find((s) => s.id === id),
    notice: null,
    dismissNotice: () => {},
    ...overrides,
  };
}
