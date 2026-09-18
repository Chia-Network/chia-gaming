import { encodeU64AsClvmHex, normalizeHexString } from '../util';

/** JSON-safe GraphQL variables (BigInt → decimal string). */
export function jsonSafeVariables(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafeVariables);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = jsonSafeVariables(v);
    }
    return out;
  }
  return value;
}

const ASSERT_BEFORE_HEIGHT_ABSOLUTE = 87n;

function serializeClvmAtom(atomHex: string): string {
  const atom = normalizeHexString(atomHex);
  if (atom.length % 2 !== 0) {
    throw new Error(`CLVM atom has odd-length hex: ${atomHex}`);
  }
  const byteLength = atom.length / 2;
  if (byteLength === 0) return '80';
  if (byteLength === 1 && Number.parseInt(atom, 16) <= 0x7f) return atom;
  if (byteLength < 0x40) {
    return `${(0x80 | byteLength).toString(16).padStart(2, '0')}${atom}`;
  }
  if (byteLength < 0x2000) {
    return `${(0xc000 | byteLength).toString(16).padStart(4, '0')}${atom}`;
  }
  if (byteLength < 0x10_0000) {
    return `${(0xe00000 | byteLength).toString(16).padStart(6, '0')}${atom}`;
  }
  throw new Error(`CLVM atom is too large: ${byteLength} bytes`);
}

export function serializeClvmCondition(condition: {
  opcode: bigint;
  args: string[];
}): string {
  const opcodeHex = encodeU64AsClvmHex(condition.opcode);
  return [opcodeHex, ...(condition.args ?? [])]
    .map((atom) => `ff${serializeClvmAtom(atom)}`)
    .join('')
    .concat('80');
}

export function conditionsForGraphql(
  extraConditions: Array<{ opcode: bigint; args: string[] }> | undefined,
  maxHeight: bigint | undefined,
): string[] {
  const conditions = [...(extraConditions ?? [])];
  if (maxHeight !== undefined) {
    conditions.push({
      opcode: ASSERT_BEFORE_HEIGHT_ABSOLUTE,
      args: [encodeU64AsClvmHex(maxHeight)],
    });
  }
  return conditions.map(serializeClvmCondition);
}

export function absAmountFromOffer(offer: { [walletId: string]: bigint }): bigint {
  const raw = offer['1'] ?? Object.values(offer)[0];
  if (raw === undefined) {
    throw new Error('createOfferForIds: offer missing amount');
  }
  return raw < 0n ? -raw : raw;
}
