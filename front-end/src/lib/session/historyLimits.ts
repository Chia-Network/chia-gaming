export const HUMAN_HISTORY_LIMIT = 1_000;
export const WASM_NOTIFICATION_HISTORY_LIMIT = 1_000;
export const DIAGNOSTIC_LOG_LIMIT = 2_000;

export function recentEntries<T>(entries: readonly T[], limit: number): T[] {
  return entries.length <= limit ? [...entries] : entries.slice(-limit);
}

export function appendRecent<T>(entries: readonly T[], entry: T, limit: number): T[] {
  return entries.length < limit
    ? [...entries, entry]
    : [...entries.slice(-(limit - 1)), entry];
}
