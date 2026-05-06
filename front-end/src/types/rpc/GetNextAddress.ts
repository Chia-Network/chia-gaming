export interface GetNextAddressRequest {
  walletId: number;
  newAddress: boolean;
}

export interface GetNextAddressResponse {
  address: string;
  walletId: number;
}
