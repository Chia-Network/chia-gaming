export type UnknownRecord = Record<string, unknown>;

export function requireRecord(value: unknown, label: string): UnknownRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value as UnknownRecord;
}

export function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}

export function optionalString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string | undefined {
  return value === undefined ? undefined : requireString(value, label, allowEmpty);
}

export function requireNullableString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string | null {
  return value === null ? null : requireString(value, label, allowEmpty);
}

export function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Garbled save: invalid ${label}`);
  return value;
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  return value === undefined ? undefined : requireBoolean(value, label);
}

export function requireBigint(value: unknown, label: string, minimum = 0n): bigint {
  if (typeof value !== 'bigint' || value < minimum) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}

export function parseDecimalString(value: unknown, label: string, minimum?: bigint): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error(`Garbled save: invalid ${label}: ${String(value)}`);
  }
  const parsed = BigInt(value);
  if (minimum !== undefined && parsed < minimum) {
    throw new Error(`Garbled save: invalid ${label}: ${value}`);
  }
  return parsed;
}

export function parseOptionalDecimalString(
  value: unknown,
  label: string,
  fallback: bigint,
  minimum?: bigint,
): bigint {
  return value === undefined ? fallback : parseDecimalString(value, label, minimum);
}

export function requireBigintString(value: string | undefined, label: string): bigint {
  if (value === undefined) throw new Error(`Garbled save: missing ${label}`);
  return parseDecimalString(value, label);
}

export function parseDiscriminant<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`Garbled save: invalid ${label}: ${String(value)}`);
  }
  return value as T;
}

export function requireUniqueIds(value: unknown, label: string, requireNonEmpty = false): string[] {
  if (
    !Array.isArray(value) ||
    (requireNonEmpty && value.length === 0) ||
    !value.every((id) => typeof id === 'string' && id.length > 0)
  ) {
    throw new Error(`Garbled save: ${label} must contain non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`Garbled save: duplicate ${label}`);
  }
  return value;
}

export function parseStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return [...value];
}
