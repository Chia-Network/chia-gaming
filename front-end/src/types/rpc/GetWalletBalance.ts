import { WalletBalance } from '../WalletBalance';

export interface GetWalletBalanceRequest {
  walletId?: bigint;
}

export type GetWalletBalanceResponse = WalletBalance;
