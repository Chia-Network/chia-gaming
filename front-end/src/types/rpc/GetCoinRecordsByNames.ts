import { CoinRecord } from './CoinRecord';

export interface GetCoinRecordsByNamesRequest {
  names: string[];
  startHeight?: bigint;
  endHeight?: bigint;
  includeSpentCoins?: boolean;
  allowUnsynced?: boolean;
  allowMissing?: boolean;
}

export interface GetCoinRecordsByNamesResponse {
  coinRecords: CoinRecord[];
  success: boolean;
}
