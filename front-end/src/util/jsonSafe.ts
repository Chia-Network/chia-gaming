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
