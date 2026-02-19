# Chat Filters Implementation Plan

## Overview

Add a filter bar between the chat list header and the chat list with: bookmark toggle (moved from header), an advanced filter button (modal), and an inline content search field.

---

## UI Layout (New)

```
┌──────────────────────────────────────────────┐
│ Header: "Claude Code" + [Queue] [New] [Gear] │
├──────────────────────────────────────────────┤
│ Filter Bar:                                  │
│ [★ Bookmark] [⚙ Filter] [🔍 Search.........] │
├──────────────────────────────────────────────┤
│ [Optional: New chat creation panel]          │
├──────────────────────────────────────────────┤
│ Scrollable chat list (filtered)              │
└──────────────────────────────────────────────┘
```

- **Bookmark toggle**: Moved from the header to the filter bar
- **Filter button**: Opens `ChatFilterModal`; highlighted when any filter is active
- **Search field**: Inline text input with eyeglass icon; icon dims while search is in-flight

---

## Implementation Steps

### Step 1: Create `types/chatFilters.ts`

**File**: `frontend/src/types/chatFilters.ts` (new)

Define shared types for filter state:

```typescript
export interface ChatFilters {
  directoryInclude: { pattern: string; active: boolean };
  directoryExclude: { pattern: string; active: boolean };
  dateMin: { value: string; active: boolean };  // ISO datetime string or ""
  dateMax: { value: string; active: boolean };  // ISO datetime string or ""
}

export const DEFAULT_CHAT_FILTERS: ChatFilters = {
  directoryInclude: { pattern: "", active: false },
  directoryExclude: { pattern: "", active: false },
  dateMin: { value: "", active: false },
  dateMax: { value: "", active: false },
};

export function hasActiveFilters(filters: ChatFilters): boolean {
  return (
    (filters.directoryInclude.active && filters.directoryInclude.pattern !== "") ||
    (filters.directoryExclude.active && filters.directoryExclude.pattern !== "") ||
    (filters.dateMin.active && filters.dateMin.value !== "") ||
    (filters.dateMax.active && filters.dateMax.value !== "")
  );
}
```

---

### Step 2: Create `ChatFilterModal.tsx`

**File**: `frontend/src/components/ChatFilterModal.tsx` (new)

A modal using `ModalOverlay` (same pattern as `ConfirmModal` / `DraftModal`) with:

1. **Directory Include Regex** — text input + active/inactive toggle
2. **Directory Exclude Regex** — text input + active/inactive toggle
3. **Minimum Datetime** — `datetime-local` input + active/inactive toggle
4. **Maximum Datetime** — `datetime-local` input + active/inactive toggle
5. **Apply / Cancel** buttons

**Props**:
```typescript
interface ChatFilterModalProps {
  isOpen: boolean;
  onClose: () => void;
  filters: ChatFilters;
  onApply: (filters: ChatFilters) => void;
}
```

**Behavior**:
- Each filter row has: label, input field, and a small toggle button
- Toggle button styling: `var(--accent)` background when active, `var(--bg-secondary)` when inactive
- The modal edits a local copy of `filters`; only calls `onApply` when user clicks Apply
- Cancel discards changes and closes
- Invalid regex gets a red border visual hint (wrap `new RegExp()` in try/catch for validation)

---

### Step 3: Create `ChatFilterBar.tsx`

**File**: `frontend/src/components/ChatFilterBar.tsx` (new)

Horizontal flex row sitting between the header and the chat list.

**Contents (left to right)**:
1. **Bookmark toggle button** — same icon/styling as current, moved here from header
2. **Filter button** — `Filter` or `SlidersHorizontal` icon from lucide-react
   - Highlighted (`var(--accent)` bg, white text) when `hasActiveFilters()` returns true
   - Normal state: `var(--bg-secondary)` bg, `var(--text)` color
3. **Search input** — flex-grow text field with grouped `Search` (eyeglass) icon
   - Placeholder: `"Search chat contents..."`
   - Eyeglass icon dims (opacity 0.4) or swaps to spinning `Loader2` while `isSearching` is true
   - `onChange` calls debounced search handler

**Props**:
```typescript
interface ChatFilterBarProps {
  bookmarkFilter: boolean;
  onToggleBookmark: () => void;
  filters: ChatFilters;
  onFiltersChange: (filters: ChatFilters) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  isSearching: boolean;
}
```

**Styling**: `padding: 8px 20px`, `gap: 8px`, consistent with header button styles.

---

### Step 4: Create `useChatSearch.ts` hook

**File**: `frontend/src/hooks/useChatSearch.ts` (new)

Custom hook for debounced content search:

```typescript
export function useChatSearch(query: string, debounceMs = 500) {
  // Returns: { matchingChatIds: Set<string> | null, isSearching: boolean }
  // null = no search active (show all chats)
  // empty Set = search returned no results
}
```

**Behavior**:
- When `query` is empty → `matchingChatIds = null`, `isSearching = false`
- When `query` changes → set `isSearching = true`, start debounce timer
- After debounce → call `searchChatContents(query)` API
- On response → update `matchingChatIds` as a `Set<string>`, set `isSearching = false`
- Use AbortController or request ID to prevent stale responses from overwriting newer results
- Clearing the field immediately resets (no debounce for empty)

---

### Step 5: Add backend search endpoint

**File**: `backend/src/routes/chats.ts` (modify)

Add `GET /chats/search?q=<query>`:

```typescript
chatsRouter.get("/search", (req, res) => {
  const query = (req.query.q as string || "").trim();
  if (!query) return res.json({ chatIds: [] });

  // Use execFileSync with grep for performance (no shell injection risk)
  // grep -rl -i <query> <CLAUDE_PROJECTS_DIR> --include="*.jsonl"
  // Parse matching file paths to extract session IDs
  // Return { chatIds: string[] }
});
```

**Important**: Use `child_process.execFileSync('grep', [...args])` (NOT `execSync` with string interpolation) to prevent shell injection.

**Performance**: `grep -rl` is fast — it stops reading a file as soon as a match is found, and operates at filesystem level.

---

### Step 6: Add `searchChatContents` to `api.ts`

**File**: `frontend/src/api.ts` (modify)

```typescript
export async function searchChatContents(query: string): Promise<{ chatIds: string[] }> {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`${BASE}/chats/search?${params}`);
  await assertOk(res, "Failed to search chats");
  return res.json();
}
```

---

### Step 7: Integrate into `ChatList.tsx`

**File**: `frontend/src/pages/ChatList.tsx` (modify)

This is the largest change. Key modifications:

#### 7a. State additions
```typescript
const [filters, setFilters] = useState<ChatFilters>(DEFAULT_CHAT_FILTERS);
const [searchQuery, setSearchQuery] = useState("");
```

#### 7b. Use `useChatSearch` hook
```typescript
const { matchingChatIds, isSearching } = useChatSearch(searchQuery);
```

#### 7c. Move bookmark toggle out of header
- Remove the `<Bookmark>` button from the `<header>` button group
- It now lives inside `ChatFilterBar`

#### 7d. Render `ChatFilterBar`
- Place between `</header>` and the `{showNew && ...}` block
- Pass all filter state and handlers as props

#### 7e. Data loading strategy
When any advanced filter or content search is active:
- Fetch ALL chats (`limit: 9999, offset: 0`) to ensure no matches are missed by pagination
- Hide the "Load more" button

When no filters are active (and no bookmark filter):
- Normal paginated loading (existing behavior)

#### 7f. Client-side filtering via `useMemo`
```typescript
const filteredChats = useMemo(() => {
  let result = chats;

  // Directory include regex
  if (filters.directoryInclude.active && filters.directoryInclude.pattern) {
    try {
      const regex = new RegExp(filters.directoryInclude.pattern, "i");
      result = result.filter(c => regex.test(c.displayFolder || c.folder));
    } catch { /* invalid regex, skip */ }
  }

  // Directory exclude regex
  if (filters.directoryExclude.active && filters.directoryExclude.pattern) {
    try {
      const regex = new RegExp(filters.directoryExclude.pattern, "i");
      result = result.filter(c => !regex.test(c.displayFolder || c.folder));
    } catch { /* invalid regex, skip */ }
  }

  // Date min
  if (filters.dateMin.active && filters.dateMin.value) {
    const minTime = new Date(filters.dateMin.value).getTime();
    result = result.filter(c => new Date(c.updated_at).getTime() >= minTime);
  }

  // Date max
  if (filters.dateMax.active && filters.dateMax.value) {
    const maxTime = new Date(filters.dateMax.value).getTime();
    result = result.filter(c => new Date(c.updated_at).getTime() <= maxTime);
  }

  // Content search
  if (matchingChatIds !== null) {
    result = result.filter(c => matchingChatIds.has(c.id));
  }

  return result;
}, [chats, filters, matchingChatIds]);
```

#### 7g. Use `filteredChats` for rendering
Replace `chats` with `filteredChats` in the rendering section.

#### 7h. Empty state
When `filteredChats` is empty but `chats` is not empty, show: "No chats match the current filters" instead of the "No chats yet" message.

---

## Edge Cases & Considerations

| Concern | Mitigation |
|---------|------------|
| Invalid regex in filter | Wrap `new RegExp()` in try/catch; show red border on input |
| Shell injection in search | Use `execFileSync` (array args), NOT `execSync` (string) |
| Stale search results | AbortController or request counter in `useChatSearch` |
| Large chat history perf | `grep -rl` stops at first match per file; set timeout on exec |
| Pagination with filters | Fetch all chats when filters active; hide "Load more" |
| Filter persistence | Ephemeral (React state only); persists while sidebar is mounted |
| Mobile layout | Filter bar wraps; search input takes full width on narrow screens |

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `frontend/src/types/chatFilters.ts` | **Create** | Type definitions, defaults, utility |
| `frontend/src/components/ChatFilterModal.tsx` | **Create** | Advanced filter modal |
| `frontend/src/components/ChatFilterBar.tsx` | **Create** | Filter bar component |
| `frontend/src/hooks/useChatSearch.ts` | **Create** | Debounced search hook |
| `backend/src/routes/chats.ts` | **Modify** | Add `/chats/search` endpoint |
| `frontend/src/api.ts` | **Modify** | Add `searchChatContents()` |
| `frontend/src/pages/ChatList.tsx` | **Modify** | Integrate all components, filtering logic |
