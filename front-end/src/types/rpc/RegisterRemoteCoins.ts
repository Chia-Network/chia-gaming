export interface RegisterRemoteCoinsRequest {
  walletId: number;
  coinIds: string[];
}

export type RegisterRemoteCoinsResponse = Record<string, never>;
