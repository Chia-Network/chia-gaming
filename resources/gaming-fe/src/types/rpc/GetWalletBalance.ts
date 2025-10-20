import { WalletBalance } from "../WalletBalance";

export interface GetWalletBalanceRequest {
  walletId?: number;
}

export type GetWalletBalanceResponse = WalletBalance;
