export interface NftWalletWithDids {
    didId: string;
    didWalletId: number;
    walletId: number;
}

export interface GetNftWalletsWithDidsRequest {}

export type GetNftWalletsWithDidsResponse = NftWalletWithDids[];
