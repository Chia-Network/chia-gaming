import { NftInfo } from "../NftInfo";

export interface MintNftRequest {
  walletId: number;
  royaltyAddress: string;
  royaltyPercentage: number;
  targetAddress: string;
  uris: string[];
  hash: string;
  metaUris: string[];
  metaHash: string;
  licenseUris: string[];
  licenseHash: string;
  editionNumber: number;
  editionCount: number;
  didId: string;
  fee: number;
}

export type MintNftResponse = NftInfo;
