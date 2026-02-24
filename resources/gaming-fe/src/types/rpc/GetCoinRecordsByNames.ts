export interface GetCoinRecordsByNamesRequest {
  names: string[];
  startHeight?: number;
  endHeight?: number;
  includeSpentCoins?: boolean;
}

export interface CoinRecord {
  coin?: {
    parentCoinInfo?: string;
    puzzleHash?: string;
    amount?: number;
  };
  confirmedBlockIndex?: number;
  spentBlockIndex?: number;
  spent?: boolean;
  coinbase?: boolean;
  timestamp?: number;
  walletType?: number;
  walletId?: number;
  [key: string]: unknown;
}

export interface GetCoinRecordsByNamesResponse {
  coinRecords: CoinRecord[];
  [key: string]: unknown;
}
