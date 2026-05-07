export interface WalletBalance {
  confirmedWalletBalance: bigint;
  fingerprint: bigint;
  maxSendAmount: bigint;
  pendingChange: bigint;
  pendingCoinRemovalCount: bigint;
  spendableBalance: bigint;
  unconfirmedWalletBalance: bigint;
  unspentCoinCount: bigint;
  walletId: bigint;
  walletType: bigint;
  pendingBalance: string;
  pendingTotalBalance: string;
}
