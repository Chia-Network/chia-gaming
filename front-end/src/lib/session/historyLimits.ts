export const HUMAN_HISTORY_LIMIT = 1_000;
export const WASM_NOTIFICATION_HISTORY_LIMIT = 1_000;
export const DIAGNOSTIC_LOG_LIMIT = 2_000;
export const DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT = 256 * 1024;

const utf8Encoder = new TextEncoder();

export function recentEntries<T>(entries: readonly T[], limit: number): T[] {
  return entries.length <= limit ? [...entries] : entries.slice(-limit);
}

export function appendRecent<T>(entries: readonly T[], entry: T, limit: number): T[] {
  return entries.length < limit ? [...entries, entry] : [...entries.slice(-(limit - 1)), entry];
}

export function diagnosticLogUtf8Bytes(entries: readonly string[]): number {
  return entries.reduce((total, entry) => total + utf8Encoder.encode(entry).byteLength, 0);
}

/**
 * Keep the newest contiguous complete diagnostics that fit the byte budget.
 * An entry that cannot fit by itself is dropped; strings are never split.
 */
export function recentDiagnosticEntries(entries: readonly string[]): string[] {
  const countBounded = recentEntries(entries, DIAGNOSTIC_LOG_LIMIT);
  const retained: string[] = [];
  let bytes = 0;

  for (let index = countBounded.length - 1; index >= 0; index -= 1) {
    const entry = countBounded[index];
    const entryBytes = utf8Encoder.encode(entry).byteLength;
    if (entryBytes > DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT) continue;
    if (bytes + entryBytes > DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT) break;
    retained.push(entry);
    bytes += entryBytes;
  }

  retained.reverse();
  return retained;
}

export function appendDiagnosticEntry(entries: readonly string[], entry: string): string[] {
  return recentDiagnosticEntries([...entries, entry]);
}
