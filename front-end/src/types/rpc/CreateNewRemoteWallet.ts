export type CreateNewRemoteWalletRequest = { allowUnsynced?: boolean };

export interface CreateNewRemoteWalletResponse {
  walletId: bigint;
}
