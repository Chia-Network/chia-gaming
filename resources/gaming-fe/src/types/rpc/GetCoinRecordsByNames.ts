import { CoinRecord } from './CoinRecord';

export interface GetCoinRecordsByNamesRequest {
  names: string[];
  startHeight?: number;
  endHeight?: number;
  includeSpentCoins?: boolean;
}

export type GetCoinRecordsByNamesResponse = CoinRecord[];
