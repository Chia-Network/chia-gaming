import { SpendBundle } from '../SpendBundle';

export interface TransferNftRequest {
  walletId: number;
  nftCoinIds: string[];
  targetAddress: string;
  fee: number;
}

export interface TransferNftResponse {
  walletId: number | number[];
  spendBundle: SpendBundle;
  txNum?: number;
}
