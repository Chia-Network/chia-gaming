export type GetHeightInfoRequest = Record<string, never>;

export interface GetHeightInfoResponse {
  height: number;
  isTransactionBlock: boolean;
  latestTransactionBlockHeight: number;
  success: boolean;
}
