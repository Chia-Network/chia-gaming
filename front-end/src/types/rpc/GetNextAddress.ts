export interface GetNextAddressRequest {
  walletId: bigint;
  newAddress: boolean;
}

// The wallet's transformResponse extracts just the address string.
export type GetNextAddressResponse = string;
