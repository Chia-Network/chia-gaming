export interface RegisterRemoteCoinsRequest {
  walletId: bigint;
  coinIds: string[];
}

export type RegisterRemoteCoinsResponse = Record<string, never>;
