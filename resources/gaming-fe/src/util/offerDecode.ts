import pako from 'pako';

const BECH32M_CONST = 0x2bc830a3;
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CHARSET_REV: Record<string, number> = {};
for (let i = 0; i < CHARSET.length; i++) CHARSET_REV[CHARSET[i]] = i;

function bech32mPolymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32mHrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function decodeBech32m(str: string): Uint8Array {
  const lower = str.toLowerCase();
  const sepIdx = lower.lastIndexOf('1');
  if (sepIdx < 1) throw new Error('bech32m: no separator');

  const hrp = lower.slice(0, sepIdx);
  const dataPart = lower.slice(sepIdx + 1);
  if (dataPart.length < 6) throw new Error('bech32m: data too short');

  const data5: number[] = [];
  for (const ch of dataPart) {
    const v = CHARSET_REV[ch];
    if (v === undefined) throw new Error(`bech32m: invalid char '${ch}'`);
    data5.push(v);
  }

  const check = bech32mPolymod([...bech32mHrpExpand(hrp), ...data5]);
  if (check !== BECH32M_CONST) throw new Error('bech32m: invalid checksum');

  const payload5 = data5.slice(0, data5.length - 6);

  const outLen = Math.floor((payload5.length * 5) / 8);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let pos = 0;
  for (const v of payload5) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out[pos++] = (acc >> bits) & 0xff;
    }
  }
  return out.slice(0, pos);
}

class StreamReader {
  private buf: Uint8Array;
  private pos: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.pos = 0;
  }

  readBytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) {
      throw new Error(
        `StreamReader: tried to read ${n} bytes at offset ${this.pos}, but buffer length is ${this.buf.length}`,
      );
    }
    const slice = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  readU32(): number {
    const bytes = this.readBytes(4);
    return (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  }

  readU64BigEndian(): Uint8Array {
    return this.readBytes(8);
  }

  readLenPrefixed(): Uint8Array {
    const len = this.readU32();
    return this.readBytes(len);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Encode a big-endian uint64 (8 bytes) as a CLVM integer:
 * minimal-length big-endian with a leading 0x00 if the high bit is set.
 */
function uint64ToClvmInt(be8: Uint8Array): number[] {
  let start = 0;
  while (start < be8.length - 1 && be8[start] === 0) {
    start++;
  }
  if (start === be8.length) return [];

  const trimmed = be8.slice(start);
  if (trimmed[0] & 0x80) {
    return [0, ...trimmed];
  }
  return [...trimmed];
}

/**
 * Decode a Chia offer bech32m string into the project's internal SpendBundle
 * JSON format expected by the WASM `provide_coin_spend_bundle`.
 *
 * Offer wire format:
 *   bech32m("offer", zlib.compress(streamable_bytes(SpendBundle)))
 *
 * Streamable SpendBundle layout:
 *   u32          num_coin_spends
 *   CoinSpend[]  coin_spends
 *   [96]         aggregated_signature (G2Element)
 *
 * Streamable CoinSpend layout:
 *   [32]  parent_coin_info
 *   [32]  puzzle_hash
 *   [8]   amount (big-endian u64)
 *   u32   puzzle_reveal_len
 *   [len] puzzle_reveal (serialized CLVM)
 *   u32   solution_len
 *   [len] solution (serialized CLVM)
 */
export function decodeOfferToInternalSpendBundle(offerBech32: string): any {
  const compressedBytes = decodeBech32m(offerBech32);

  let raw: Uint8Array;
  try {
    raw = pako.inflate(compressedBytes);
  } catch {
    raw = compressedBytes;
  }

  const reader = new StreamReader(raw);
  const numSpends = reader.readU32();
  const aggSigHex: string[] = [];
  const spends: any[] = [];

  for (let i = 0; i < numSpends; i++) {
    const parentCoinInfo = reader.readBytes(32);
    const puzzleHash = reader.readBytes(32);
    const amountBe = reader.readU64BigEndian();
    const puzzleReveal = reader.readLenPrefixed();
    const solution = reader.readLenPrefixed();

    const clvmAmount = uint64ToClvmInt(amountBe);
    const coinBytes = [...parentCoinInfo, ...puzzleHash, ...clvmAmount];

    spends.push({
      coin: coinBytes,
      bundle: {
        puzzle: [...puzzleReveal],
        solution: [...solution],
        signature: '', // placeholder, filled after reading agg sig
      },
    });
  }

  const aggSig = reader.readBytes(96);
  const aggSigStr = bytesToHex(aggSig);

  for (const spend of spends) {
    spend.bundle.signature = aggSigStr;
  }

  return { name: null, spends };
}
