export interface GetNextAddressRequest {
    walletId?: number;
    newAddress?: boolean;
}

export type GetNextAddressResponse = string;
