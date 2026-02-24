export interface RegisterRemoteCoinsRequest {
  walletId: number;
  coinIds: string[];
}

export interface RegisterRemoteCoinsResponse {
  success?: boolean;
  [key: string]: unknown;
}
