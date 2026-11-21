/**
 * Largest transcript, in bytes, any content search reads. Shared by the
 * content-search worker and the adapters' own `searchSessions`, so neither path
 * slurps an outsized log — and on the adapter path, not on the main thread.
 */
export const CONTENT_SEARCH_MAX_FILE_BYTES = 32 * 1024 * 1024;
