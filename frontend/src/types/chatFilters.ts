export interface ChatFilterField<T> {
  value: T;
  active: boolean;
}

export interface ChatFilters {
  directoryInclude: ChatFilterField<string>;
  directoryExclude: ChatFilterField<string>;
  dateMin: ChatFilterField<string>; // ISO datetime string or ""
  dateMax: ChatFilterField<string>; // ISO datetime string or ""
}

export const DEFAULT_CHAT_FILTERS: ChatFilters = {
  directoryInclude: { value: "", active: false },
  directoryExclude: { value: "", active: false },
  dateMin: { value: "", active: false },
  dateMax: { value: "", active: false },
};

export function hasActiveFilters(filters: ChatFilters): boolean {
  return (
    (filters.directoryInclude.active && filters.directoryInclude.value !== "") ||
    (filters.directoryExclude.active && filters.directoryExclude.value !== "") ||
    (filters.dateMin.active && filters.dateMin.value !== "") ||
    (filters.dateMax.active && filters.dateMax.value !== "")
  );
}
