/**
 * Clone values for React props while preserving bigints (as non-enumerable
 * properties) and leaving binary views intact.
 *
 * React cannot safely enumerate bigint props; we hide them. Typed arrays must
 * NOT be expanded into plain `{0:n,1:n,...}` objects — that destroys
 * `serializedCradle` / message bytes and makes WASM restore fail with
 * bencodex "unexpected end of input".
 *
 * Degraded byte blobs (numeric-keyed plain objects from a prior spread of a
 * TypedArray) must also not be deep-cloned: `{ ...millionKeyObject }` OOMs.
 */

/** Probe without enumerating all keys — Object.keys on a huge byte-object OOMs. */
export function isDenseNumericByteObject(value: object): boolean {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, '0')) return false;
  if (typeof record['0'] !== 'number') return false;
  // Real cradles are far larger than this; small numeric-key maps stay cloneable.
  for (const idx of ['256', '1024', '4096'] as const) {
    if (!Object.prototype.hasOwnProperty.call(record, idx)) return false;
    const byte = record[idx];
    if (typeof byte !== 'number' || byte < 0 || byte > 255) return false;
  }
  return true;
}

export function reactPropSafeValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (isDenseNumericByteObject(value)) return value;
  if (Array.isArray(value)) {
    // Huge number[] byte blobs: share the reference rather than mapping.
    if (
      value.length > 4096
      && typeof value[0] === 'number'
      && typeof value[4096] === 'number'
    ) {
      return value;
    }
    const copy = value.map(reactPropSafeValue);
    value.forEach((item, index) => {
      if (typeof item === 'bigint') {
        Object.defineProperty(copy, index, {
          value: item,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }
    });
    return copy as T;
  }

  const copy = { ...(value as Record<string, unknown>) };
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (typeof nested === 'bigint') {
      Object.defineProperty(copy, key, {
        value: nested,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } else if (nested !== null && typeof nested === 'object') {
      copy[key] = reactPropSafeValue(nested);
    }
  }
  return copy as T;
}
