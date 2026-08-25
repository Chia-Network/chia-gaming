import { encodeU64AsClvmHex } from '../util';
import { BLS_NIL_SIGNATURE, normalizeHex, with0x } from './cloudWalletOAuth';
import { WalletSpendBundle } from '../types/rpc/PushTransactions';

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

export function conditionsForGraphql(
  extraConditions: Array<{ opcode: bigint; args: string[] }> | undefined,
  maxHeight: bigint | undefined,
): Array<{ opcode: string; args: string[] }> {
  const out: Array<{ opcode: string; args: string[] }> = [];
  for (const c of extraConditions ?? []) {
    out.push({
      opcode: c.opcode.toString(),
      args: (c.args ?? []).map((a) => String(a)),
    });
  }
  if (maxHeight !== undefined) {
    out.push({
      opcode: '87',
      args: [encodeU64AsClvmHex(maxHeight)],
    });
  }
  return out;
}

export function selectCoinStringForAmount(
  coins: Array<{
    name?: string;
    parentCoinInfo?: string;
    puzzleHash?: string;
    amount?: string | number | bigint;
  }>,
  amount: bigint,
): string | null {
  const sorted = [...coins].sort((a, b) => {
    const aa = BigInt(a.amount ?? 0);
    const bb = BigInt(b.amount ?? 0);
    if (aa < bb) return -1;
    if (aa > bb) return 1;
    return 0;
  });
  for (const selected of sorted) {
    const amt = BigInt(selected.amount ?? 0);
    if (amt < amount) continue;
    const parent = normalizeHex(selected.parentCoinInfo);
    const ph = normalizeHex(selected.puzzleHash);
    if (parent.length === 64 && ph.length === 64) {
      return `${parent}${ph}${encodeU64AsClvmHex(amt)}`;
    }
  }
  return null;
}

function byteaToHex(value: unknown): string {
  return normalizeHex(value);
}

export function coinSpendsToWalletBundle(
  coinSpends: any[],
  aggregatedSignature?: string | null,
): WalletSpendBundle {
  const coin_spends = coinSpends.map((cs) => {
    const coin = cs.coin ?? {};
    return {
      coin: {
        parent_coin_info: with0x(byteaToHex(coin.parentCoinInfo ?? coin.parent_coin_info)),
        puzzle_hash: with0x(byteaToHex(coin.puzzleHash ?? coin.puzzle_hash)),
        amount: BigInt(coin.amount ?? 0),
      },
      puzzle_reveal: with0x(byteaToHex(cs.puzzleReveal ?? cs.puzzle_reveal)),
      solution: with0x(byteaToHex(cs.solution)),
    };
  });
  return {
    coin_spends,
    aggregated_signature: aggregatedSignature ? with0x(aggregatedSignature) : BLS_NIL_SIGNATURE,
  };
}

export function absAmountFromOffer(offer: { [walletId: string]: bigint }): bigint {
  const raw = offer['1'] ?? Object.values(offer)[0];
  if (raw === undefined) {
    throw new Error('createOfferForIds: offer missing amount');
  }
  return raw < 0n ? -raw : raw;
}
