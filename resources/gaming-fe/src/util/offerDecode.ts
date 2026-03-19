import bech32_module from 'bech32-buffer';
import * as bech32_buffer from 'bech32-buffer';
import pako from 'pako';

const bech32: any = bech32_module ? bech32_module : bech32_buffer;

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
  const decoded = bech32.decode(offerBech32);
  const compressedBytes: Uint8Array = new Uint8Array(decoded.data);

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
