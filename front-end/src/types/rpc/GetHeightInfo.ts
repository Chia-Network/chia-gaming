export type GetHeightInfoRequest = Record<string, never>;

export interface GetHeightInfoResponse {
  height: number;
  isTransactionBlock: boolean | null;
  prevTransactionBlockHeight: number | null;
  latestTransactionBlockHeight: number;
  success: boolean;
}
