export interface GetCatWalletInfoRequest {
    assetId: string;
}

export interface GetCatWalletInfoResponse {
    name: string;
    walletId: number;
    success: true;
}
