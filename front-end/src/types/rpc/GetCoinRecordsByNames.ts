import { CoinRecord } from './CoinRecord';

export interface GetCoinRecordsByNamesRequest {
  names: string[];
  startHeight?: number;
  endHeight?: number;
  includeSpentCoins?: boolean;
}

export interface GetCoinRecordsByNamesResponse {
  coinRecords: CoinRecord[];
  success: boolean;
}
