export interface SetDidNameRequest {
  walletId: number;
  name: string;
}

export interface SetDidNameResponse {
  walletId: number;
  success: true;
}
