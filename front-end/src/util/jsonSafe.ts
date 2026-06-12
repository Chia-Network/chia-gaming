export function jsonParse(text: string): any {
  return JSON.parse(text, (_key, value) => {
    if (typeof value === 'number' && Number.isInteger(value)) {
      return BigInt(value);
    }
    return value;
  });
}

function jsonValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof Uint8Array) return JSON.stringify(Array.from(v));
  if (Array.isArray(v)) return `[${v.map(jsonValue).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .map(([k, val]) => `${JSON.stringify(k)}:${jsonValue(val)}`);
  return `{${entries.join(',')}}`;
}

export function jsonStringify(value: any): string {
  return jsonValue(value);
}

const BIGINT_TAG = '$bigint';

function isBigintTag(value: unknown): value is { [BIGINT_TAG]: string } {
  if (value === null || typeof value !== 'object') return false;
  const entries = Object.entries(value);
  return entries.length === 1 &&
    entries[0][0] === BIGINT_TAG &&
    typeof entries[0][1] === 'string' &&
    /^-?\d+$/.test(entries[0][1]);
}

export function jsonParseLossless(text: string): any {
  return JSON.parse(text, (_key, value) => {
    if (isBigintTag(value)) {
      return BigInt(value[BIGINT_TAG]);
    }
    if (typeof value === 'number' && Number.isInteger(value)) {
      return BigInt(value);
    }
    return value;
  });
}

function jsonLosslessValue(v: unknown): string {
  if (typeof v === 'bigint') return `{${JSON.stringify(BIGINT_TAG)}:${JSON.stringify(v.toString())}}`;
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof Uint8Array) return JSON.stringify(Array.from(v));
  if (Array.isArray(v)) return `[${v.map(jsonLosslessValue).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .map(([k, val]) => `${JSON.stringify(k)}:${jsonLosslessValue(val)}`);
  return `{${entries.join(',')}}`;
}

export function jsonStringifyLossless(value: any): string {
  return jsonLosslessValue(value);
}
