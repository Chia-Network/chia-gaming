import { WalletInfo } from '../WalletInfo';

export interface GetWalletsRequest {
    includeData: boolean;
}

export type GetWalletsResponse = WalletInfo[];
