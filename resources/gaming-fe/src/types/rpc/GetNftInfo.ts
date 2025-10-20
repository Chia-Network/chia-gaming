import { NftInfo } from '../NftInfo';

export interface GetNftInfoRequest {
  coinId: string;
}

export type GetNftInfoResponse = NftInfo;
