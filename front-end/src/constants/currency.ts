import { storageRepository } from '../lib/session/storageRepository';

/**
 * User-visible currency labels for the selected Chia network. Testnet uses the
 * T-prefixed nomenclature (TXCH / TMojo); mainnet keeps the standard names.
 *
 * The repository-owned aggregate is the only preference authority.
 */
export interface CurrencyLabels {
  /** Uppercase ticker: XCH / TXCH. */
  xch: string;
  /** Lowercase word for the coin: chia / TXCH. */
  chia: string;
  /** Singular sub-unit, lowercase: mojo / TMojo. */
  mojo: string;
  /** Plural sub-unit, lowercase: mojos / TMojos. */
  mojos: string;
  /** Uppercase sub-unit: MOJO / TMOJO. */
  MOJO: string;
}

function readNetworkIsTestnet(): boolean {
  return storageRepository.query('network') === 'testnet';
}

export function isTestnet(): boolean {
  return readNetworkIsTestnet();
}

export function getCurrencyLabels(): CurrencyLabels {
  const t = readNetworkIsTestnet();
  return {
    xch: t ? 'TXCH' : 'XCH',
    chia: t ? 'TXCH' : 'chia',
    mojo: t ? 'TMojo' : 'mojo',
    mojos: t ? 'TMojos' : 'mojos',
    MOJO: t ? 'TMOJO' : 'MOJO',
  };
}
