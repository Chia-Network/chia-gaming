export interface RegisterRemoteCoinsRequest {
  walletId: number;
  coins: string[];
}

export type RegisterRemoteCoinsResponse = Record<string, never>;
