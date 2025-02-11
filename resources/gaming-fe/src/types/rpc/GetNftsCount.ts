export interface GetNftsCountRequest {
    walletIds: number[];
}

export type GetNftsCountResponse = Record<string, number> & { total: number };
