import { CoinRecord } from '../types/rpc/CoinRecord';
import { WatchReport } from '../types/ChiaGaming';
import { toHexString, toUint8 } from '../util';

function encodeClvmInt(n: number): Uint8Array {
  if (n === 0) return new Uint8Array(0);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
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

/**
 * Diff coin records against watched coin names; mutates `previousCoinStates` like the wallet path.
 */
export async function applyCoinRecordsWatchDiff(
  records: CoinRecord[],
  coinNameToString: Map<string, string>,
  previousCoinStates: Map<string, boolean>,
): Promise<WatchReport> {
  const created_watched: string[] = [];
  const deleted_watched: string[] = [];
  const timed_out: string[] = [];

  for (const rec of records) {
    const coinName = await coinRecordToName(rec);
    if (!coinName) continue;

    const coinString = coinNameToString.get(coinName);
    if (!coinString) continue;

    const isSpent = rec.spent ?? rec.spentBlockIndex > 0;

    const wasSpent = previousCoinStates.get(coinName);
    const wasSeen = wasSpent !== undefined;

    if (!wasSeen) {
      created_watched.push(coinString);
      previousCoinStates.set(coinName, isSpent);
    }

    if (isSpent && !wasSpent) {
      deleted_watched.push(coinString);
      previousCoinStates.set(coinName, true);
    }
  }

  return { created_watched, deleted_watched, timed_out };
}
