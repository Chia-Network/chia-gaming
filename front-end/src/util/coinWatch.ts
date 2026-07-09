import { CoinRecord } from '../types/rpc/CoinRecord';
import { toHexString, toUint8 } from '../util';

function encodeClvmInt(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  const bytes: number[] = [];
  let v = n;
  while (v > 0n) {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  if (bytes[0] & 0x80) {
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

/** SHA-256 coin name (hex) from wallet-shaped coin record (matches on-chain coin id). */
export async function coinRecordToName(rec: CoinRecord): Promise<string | undefined> {
  try {
    const parentBytes = toUint8(rec.coin.parentCoinInfo.replace(/^0x/, ''));
    const puzzleBytes = toUint8(rec.coin.puzzleHash.replace(/^0x/, ''));
    const amountBytes = encodeClvmInt(rec.coin.amount);

    const data = new Uint8Array(parentBytes.length + puzzleBytes.length + amountBytes.length);
    data.set(parentBytes, 0);
    data.set(puzzleBytes, parentBytes.length);
    data.set(amountBytes, parentBytes.length + puzzleBytes.length);

    const hash = await crypto.subtle.digest('SHA-256', data);
    return toHexString(Array.from(new Uint8Array(hash)));
  } catch {
    return undefined;
  }
}
