export function parseAmount(value: unknown): bigint | null {
  if (value == null) return null;
  try {
    if (typeof value === 'object' && 'Amount' in (value as Record<string, unknown>)) {
      return BigInt(String((value as Record<string, unknown>).Amount));
    }
    return BigInt(String(value));
  } catch {
    return null;
  }
}
