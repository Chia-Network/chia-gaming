import { PREFERENCES_KEY } from '../hooks/savePreferences';

/**
 * User-visible currency labels for the selected Chia network. Testnet uses the
 * T-prefixed nomenclature (TXCH / TMojo); mainnet keeps the standard names.
 *
 * The network preference is read from the persisted `appPreferences` blob so
 * this stays a side-effect-free leaf module (no dependency on the save graph,
 * which imports `util` and would otherwise form an import cycle).
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
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { network?: unknown };
    return parsed.network === 'testnet';
  } catch {
    return false;
  }
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
