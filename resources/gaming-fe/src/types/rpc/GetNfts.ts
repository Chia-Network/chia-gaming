import { NftInfo } from '../NftInfo';

export interface GetNftsRequest {
    walletIds: number[];
    num: number;
    startIndex: number;
}

export type GetNftsResponse = Record<string, NftInfo[]>;
