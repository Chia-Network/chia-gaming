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

/** Decode a non-negative CLVM integer atom given as hex (empty atom = 0). */
function decodeNonNegativeClvmIntHex(hex: string): bigint {
  const clean = hex.trim().toLowerCase().replace(/^0x/, '');
  if (clean === '') return 0n;
  const normalized = clean.length % 2 === 0 ? clean : `0${clean}`;
  const bytes = normalized.match(/.{1,2}/g)?.map((b) => Number.parseInt(b, 16)) ?? [];
  if (bytes.length === 0) return 0n;
  if ((bytes[0] & 0x80) !== 0 && bytes[0] !== 0) {
    throw new Error(`unexpected negative CLVM integer encoding: ${hex}`);
  }
  let result = 0n;
  for (const b of bytes) {
    result = (result << 8n) + BigInt(b);
  }
  return result;
}

const ASSERT_BEFORE_HEIGHT_ABSOLUTE = 87n;
const CREATE_COIN = 51n;

function graphqlArgsForCondition(opcode: bigint, args: string[]): string[] {
  const raw = args.map((a) => String(a));
  // Cloud Wallet GraphQL takes decimal integers, matching WalletConnect's
  // `{height}` / `{amount}` objects rather than CLVM atom hex.
  if (opcode === ASSERT_BEFORE_HEIGHT_ABSOLUTE && raw[0] !== undefined) {
    return [decodeNonNegativeClvmIntHex(raw[0]).toString()];
  }
  if (opcode === CREATE_COIN && raw.length >= 2) {
    return [raw[0], decodeNonNegativeClvmIntHex(raw[1]).toString(), ...raw.slice(2)];
  }
  return raw;
}

export function conditionsForGraphql(
  extraConditions: Array<{ opcode: bigint; args: string[] }> | undefined,
  maxHeight: bigint | undefined,
): Array<{ opcode: string; args: string[] }> {
  const out: Array<{ opcode: string; args: string[] }> = [];
  for (const c of extraConditions ?? []) {
    out.push({
      opcode: c.opcode.toString(),
      args: graphqlArgsForCondition(c.opcode, c.args ?? []),
    });
  }
  if (maxHeight !== undefined) {
    out.push({
      opcode: '87',
      args: [maxHeight.toString()],
    });
  }
  return out;
}

function asCoinSpends(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Pick coin spends from a SIGNED Cloud Wallet signature request.
 *
 * Vault wallets omit the custody singleton from `signatureRequest.coinSpends`
 * (clear-signing). The complete bundle is `signedSpendBundle`: inner p2 +
 * custody. Falling back to `coinSpends` broadcasts the inner spend without
 * the vault SEND_MESSAGE; the full node rejects that with
 * MESSAGE_NOT_SENT_OR_RECEIVED.
 *
 * Do not scan solutions for opcodes 66/67. MIPS emits RECEIVE_MESSAGE from the
 * puzzle, not as a quoted condition in the inner p2 solution, so a solution-only
 * regex always looks unpaired on a correct vault spend.
 */
export function coinSpendsFromSignatureRequest(sr: {
  signedSpendBundle?: { coinSpends?: unknown[] } | null;
  coinSpends?: unknown[] | null;
}): unknown[] {
  const signedSpends = asCoinSpends(sr.signedSpendBundle?.coinSpends);
  if (signedSpends.length > 0) {
    return signedSpends;
  }
  const requestSpends = asCoinSpends(sr.coinSpends);
  if (requestSpends.length > 0) {
    throw new Error(
      'Cloud Wallet signature request is missing signedSpendBundle (vault custody spend missing). Refusing to fall back to signatureRequest.coinSpends, which omits the vault custody singleton.',
    );
  }
  throw new Error(
    'Cloud Wallet signature request is signed but returned no coinSpends. Vault-less wallets may need a Cloud Wallet API fix.',
  );
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
