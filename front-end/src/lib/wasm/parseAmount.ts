export function parseAmount(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'object' && 'Amount' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).Amount);
  }
  return String(value);
}
