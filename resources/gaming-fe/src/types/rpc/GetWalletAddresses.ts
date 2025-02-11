import { WalletAddress } from '../WalletAddress';

export interface GetWalletAddressesRequest {
    fingerprints?: number[];
    index?: number;
    count?: number;
    nonObserverDerivation?: boolean;
}

export type GetWalletAddressesResponse = { [key: string]: WalletAddress[] };