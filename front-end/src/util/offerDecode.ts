function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    out.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return out;
}

function amountToClvmInt(amount: number): number[] {
  if (amount === 0) return [];
  const bytes: number[] = [];
  let v = amount;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return bytes;
}

interface ChiaCoinSpend {
  coin: {
    parent_coin_info?: string;
    parentCoinInfo?: string;
    puzzle_hash?: string;
    puzzleHash?: string;
    amount: number;
  };
  puzzle_reveal?: string;
  puzzleReveal?: string;
  solution: string;
}

/**
 * Normalize any spend bundle format into the internal `{ name, spends }` format
 * expected by the WASM `provide_coin_spend_bundle`.
 *
 * Handles:
 * - Already-internal format (has `spends` array)
 * - Chia camelCase format (has `coinSpends` array + `aggregatedSignature`)
 * - Chia snake_case format (has `coin_spends` array + `aggregated_signature`)
 *
 * Bech32m offer strings are NOT handled here -- they are decoded on the
 * Rust/WASM side via `decode_offer_bech32`.
 */
export function normalizeSpendBundle(bundle: any): any {
  if (!bundle || typeof bundle !== 'object') {
    return bundle;
  }

  if (Array.isArray(bundle.spends)) {
    return bundle;
  }

  const rawSpends: ChiaCoinSpend[] | undefined =
    bundle.coinSpends ?? bundle.coin_spends;
  const rawAggSig: string | undefined =
    bundle.aggregatedSignature ?? bundle.aggregated_signature;

  if (Array.isArray(rawSpends)) {
    const aggSig = rawAggSig
      ? (rawAggSig.startsWith('0x') ? rawAggSig.slice(2) : rawAggSig)
      : 'c' + '0'.repeat(191);

    const spends = rawSpends.map((cs) => {
      const parentHex = cs.coin.parent_coin_info ?? cs.coin.parentCoinInfo ?? '';
      const phHex = cs.coin.puzzle_hash ?? cs.coin.puzzleHash ?? '';
      const amount = cs.coin.amount;

      const coinBytes = [
        ...hexToBytes(parentHex),
        ...hexToBytes(phHex),
        ...amountToClvmInt(amount),
      ];

      const puzzleHex = cs.puzzle_reveal ?? cs.puzzleReveal ?? '';
      const solutionHex = cs.solution ?? '';

      return {
        coin: coinBytes,
        bundle: {
          puzzle: hexToBytes(puzzleHex),
          solution: hexToBytes(solutionHex),
          signature: aggSig,
        },
      };
    });

    return { name: null, spends };
  }

  return bundle;
}
