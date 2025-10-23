export interface WalletBalance {
  confirmedWalletBalance: number;
  fingerprint: number;
  maxSendAmount: number;
  pendingChange: number;
  pendingCoinRemovalCount: number;
  spendableBalance: number;
  unconfirmedWalletBalance: number;
  unspentCoinCount: number;
  walletId: number;
  walletType: number;
  pendingBalance: string;
  pendingTotalBalance: string;
}
