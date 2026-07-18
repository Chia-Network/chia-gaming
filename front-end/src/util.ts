import { Spend, CoinSpend, SpendBundle } from './types/ChiaGaming';

export function toUint8(s: string) {
  if (s.length % 2 != 0) {
    throw 'Odd length hex string';
  }
  const result = new Uint8Array(s.length >> 1);
  for (let i = 0; i < s.length; i += 2) {
    const sub = s.slice(i, i + 2);
    const val = parseInt(sub, 16);
    result[i >> 1] = val;
  }
  return result;
}

// Thanks: https://stackoverflow.com/questions/34309988/byte-array-to-hex-string-conversion-in-javascript
export function toHexString(byteArray: Uint8Array | number[]) {
  return Array.from(byteArray, function (byte) {
    return ('0' + (byte & 0xff).toString(16)).slice(-2);
  }).join('');
}

export async function coinIdFromBytes(coin: Uint8Array | number[]): Promise<string> {
  const bytes = Uint8Array.from(coin);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return toHexString(new Uint8Array(hash));
}

/**
 * Normalize an opaque byte blob (e.g. a serialized `CoinString` arriving from
 * the WASM bridge or restored from persistence) into a `Uint8Array`.
 *
 * Byte blobs are the one integer-bearing value that is intentionally NOT a
 * `bigint` (per the frontend BigInt policy, typed arrays are the exception).
 * A `Uint8Array` is exempt from the save-time `assertNoNumbers` check and is
 * persisted losslessly as a `$bytes` tag. The danger is a byte blob that has
 * lost its typed-array identity and degraded into a plain array of numbers or
 * a numeric-keyed object (`{0:93,...}`) — those trip the validator and break
 * coin parsing. This coerces any of those shapes back into a `Uint8Array`.
 */
export function coerceToBytes(value: unknown): Uint8Array | null {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value, (b) => Number(b) & 0xff);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0) return null;
    const indices = keys.map((k) => Number(k));
    if (indices.some((i) => !Number.isInteger(i) || i < 0)) return null;
    const out = new Uint8Array(Math.max(...indices) + 1);
    for (const k of keys) {
      out[Number(k)] = Number(record[k]) & 0xff;
    }
    return out;
  }
  return null;
}

export function normalizeHexString(hex: string) {
  return hex.trim().toLowerCase().replace(/^0x/, '');
}

export function normalizeCoinStringHex(coinString: string) {
  const normalized = coinString.trim().toLowerCase().replace(/0x/g, '');
  if (normalized.length % 2 !== 0) {
    throw new Error(`Invalid coin hex length: ${normalized.length}`);
  }
  return normalized;
}


function clvm_enlist(clvms: string[]): string {
  const result = [];

  for (const clvm of clvms) {
    result.push('ff');
    result.push(clvm);
  }

  result.push('80');
  return result.join('');
}

function clvm_length(atom: string): string {
  const byteLen = atom.length / 2;
  if (byteLen <= 63) {
    const alen = (byteLen | 0x80).toString(16).padStart(2, '0');
    return alen + atom;
  } else {
    const alen = (byteLen | 0xc000).toString(16).padStart(4, '0');
    return alen + atom;
  }
}

function spend_to_clvm(spend: Spend): string {
  const spend_clvm = clvm_enlist([
    spend.puzzle,
    spend.solution,
    clvm_length(spend.signature),
  ]);
  return spend_clvm;
}

function coin_spend_to_clvm(coinspend: CoinSpend): string {
  const coin_spend_clvm = clvm_enlist([
    clvm_length(coinspend.coin),
    spend_to_clvm(coinspend.bundle),
  ]);
  return coin_spend_clvm;
}

export function spend_bundle_to_clvm(sbundle: SpendBundle): string {
  const bundle_clvm = clvm_enlist(
    sbundle.spends.map((s) => coin_spend_to_clvm(s)),
  );
  return bundle_clvm;
}


export function formatAmount(mojos: bigint): string {
  if (mojos < 1_000_000n) {
    return `${mojos} MOJO`;
  }
  const TRILLION = 1_000_000_000_000n;
  const whole = mojos / TRILLION;
  const frac = mojos % TRILLION;
  if (frac === 0n) return `${whole} XCH`;
  const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
  return `${whole}.${fracStr} XCH`;
}

export function formatMojos(mojos: bigint): string {
  const TRILLION = 1_000_000_000_000n;
  const absMojos = mojos < 0n ? -mojos : mojos;
  if (absMojos >= 100_000_000n) {
    const sign = mojos < 0n ? '-' : '';
    const whole = absMojos / TRILLION;
    const frac = absMojos % TRILLION;
    const fracStr = frac.toString().padStart(12, '0').slice(0, 4);
    return `${sign}${whole.toLocaleString()}.${fracStr} XCH`;
  }
  return `${mojos.toLocaleString()} mojos`;
}
